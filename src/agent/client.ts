import { spawn, ChildProcess } from 'node:child_process';
import { createInterface, Interface as ReadlineInterface } from 'node:readline';
import { CodexConfig, TrackerConfig } from '../model/workflow.js';
import { ProtocolMessage, CodexEvent, TurnResult } from './protocol.js';
import {
  CodexNotFoundError,
  ResponseTimeoutError,
  TurnTimeoutError,
  TurnInputRequiredError,
} from '../model/errors.js';
import { logger } from '../logging/logger.js';
import { executeLinearGraphQL } from '../tracker/linear.js';

export type CodexEventCallback = (event: CodexEvent) => void;

export class AppServerClient {
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private messageQueue: ProtocolMessage[] = [];
  private messageResolvers: Array<(msg: ProtocolMessage) => void> = [];
  private nextId = 1;
  private threadId: string | null = null;
  private turnId: string | null = null;

  constructor(
    private readonly codexConfig: CodexConfig,
    private readonly trackerConfig: TrackerConfig | null,
    private readonly onEvent: CodexEventCallback,
  ) {}

  get pid(): string | null {
    return this.process?.pid?.toString() ?? null;
  }

  async start(cwd: string): Promise<{ threadId: string; turnId: string; sessionId: string }> {
    // Launch the process
    this.process = spawn('bash', ['-lc', this.codexConfig.command], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new CodexNotFoundError(this.codexConfig.command);
    }

    // Set up line reading from stdout
    this.readline = createInterface({ input: this.process.stdout });
    this.readline.on('line', (line: string) => {
      this.handleLine(line);
    });

    // Log stderr as diagnostics
    this.process.stderr?.on('data', (data: Buffer) => {
      logger.debug({ source: 'codex_stderr' }, data.toString().trim());
    });

    // Step 1: initialize
    const initResp = await this.sendRequest('initialize', {
      clientInfo: { name: 'symphony', version: '1.0' },
      capabilities: {},
    });

    if (initResp.error) {
      throw new CodexNotFoundError(`Initialize failed: ${initResp.error.message}`);
    }

    // Step 2: initialized notification
    this.sendNotification('initialized', {});

    return { threadId: '', turnId: '', sessionId: '' }; // Placeholder, set by startThread
  }

  async startThread(cwd: string): Promise<string> {
    const resp = await this.sendRequest('thread/start', {
      approvalPolicy: this.codexConfig.approvalPolicy,
      sandbox: this.codexConfig.threadSandbox,
      cwd,
    });

    this.threadId = (resp.result as Record<string, unknown>)?.thread
      ? ((resp.result as Record<string, { id: string }>).thread.id)
      : String(resp.result?.threadId ?? resp.result?.id ?? '');

    return this.threadId;
  }

  async startTurn(
    prompt: string,
    cwd: string,
    title: string,
  ): Promise<string> {
    if (!this.threadId) throw new Error('No active thread');

    const resp = await this.sendRequest('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: prompt }],
      cwd,
      title,
      approvalPolicy: this.codexConfig.approvalPolicy,
      sandboxPolicy: { type: this.codexConfig.turnSandboxPolicy },
    });

    this.turnId = (resp.result as Record<string, unknown>)?.turn
      ? ((resp.result as Record<string, { id: string }>).turn.id)
      : String(resp.result?.turnId ?? resp.result?.id ?? '');

    return this.turnId;
  }

  get sessionId(): string {
    return `${this.threadId ?? 'unknown'}-${this.turnId ?? 'unknown'}`;
  }

  async streamTurn(): Promise<TurnResult> {
    const turnTimeout = this.codexConfig.turnTimeoutMs;
    const startTime = Date.now();

    while (true) {
      const elapsed = Date.now() - startTime;
      if (elapsed > turnTimeout) {
        throw new TurnTimeoutError();
      }

      const msg = await this.waitForMessage(turnTimeout - elapsed);

      if (!msg.method) {
        // Response to a request we sent - handle approvals/tool calls
        continue;
      }

      const event = this.messageToEvent(msg);
      this.onEvent(event);

      switch (msg.method) {
        case 'turn/completed':
          return { status: 'completed' };

        case 'turn/failed':
          return {
            status: 'failed',
            error: String((msg.params as Record<string, unknown>)?.error ?? 'unknown turn failure'),
          };

        case 'turn/cancelled':
          return {
            status: 'cancelled',
            reason: String((msg.params as Record<string, unknown>)?.reason ?? 'unknown'),
          };

        case 'item/tool/requestUserInput':
          throw new TurnInputRequiredError();

        case 'item/tool/call': {
          await this.handleToolCall(msg);
          break;
        }

        case 'item/approval/request': {
          // Auto-approve
          const approvalId = msg.id ?? (msg.params as Record<string, unknown>)?.id;
          if (approvalId) {
            this.sendResponse(approvalId, { approved: true });
          }
          break;
        }

        case 'thread/tokenUsage/updated':
        case 'thread/token_usage':
          // Token usage events are handled by messageToEvent
          break;

        default:
          // Other notifications - just pass through as events
          break;
      }
    }
  }

  private async handleToolCall(msg: ProtocolMessage): Promise<void> {
    const params = msg.params as Record<string, unknown> | undefined;
    const toolName = String(params?.name ?? params?.toolName ?? '');
    const toolCallId = msg.id ?? params?.id;

    if (toolName === 'linear_graphql' && this.trackerConfig) {
      const args = (params?.arguments ?? params?.input ?? {}) as Record<string, unknown>;
      const query = String(args.query ?? '');
      const variables = (args.variables ?? undefined) as Record<string, unknown> | undefined;
      const result = await executeLinearGraphQL(this.trackerConfig, query, variables);
      if (toolCallId) {
        this.sendResponse(toolCallId, { success: result.success, data: result.data, error: result.error });
      }
    } else {
      // Unsupported tool call
      if (toolCallId) {
        this.sendResponse(toolCallId, { success: false, error: 'unsupported_tool_call' });
      }
      this.onEvent({
        event: 'unsupported_tool_call',
        timestamp: new Date(),
        codexAppServerPid: this.pid,
        payload: { toolName },
      });
    }
  }

  private messageToEvent(msg: ProtocolMessage): CodexEvent {
    const params = msg.params as Record<string, unknown> | undefined;
    let usage: CodexEvent['usage'] | undefined;

    // Try to extract token usage from various payload shapes
    const tokenData = params?.usage ?? params?.tokenUsage ?? params?.total_token_usage;
    if (tokenData && typeof tokenData === 'object') {
      const t = tokenData as Record<string, unknown>;
      usage = {
        inputTokens: Number(t.inputTokens ?? t.input_tokens ?? 0),
        outputTokens: Number(t.outputTokens ?? t.output_tokens ?? 0),
        totalTokens: Number(t.totalTokens ?? t.total_tokens ?? 0),
      };
    }

    const method = msg.method ?? 'other_message';
    let eventName: string;

    switch (method) {
      case 'turn/completed': eventName = 'turn_completed'; break;
      case 'turn/failed': eventName = 'turn_failed'; break;
      case 'turn/cancelled': eventName = 'turn_cancelled'; break;
      case 'item/approval/request': eventName = 'approval_auto_approved'; break;
      case 'item/tool/requestUserInput': eventName = 'turn_input_required'; break;
      case 'thread/tokenUsage/updated': eventName = 'notification'; break;
      default: eventName = method.includes('/') ? 'notification' : 'other_message'; break;
    }

    return {
      event: eventName,
      timestamp: new Date(),
      codexAppServerPid: this.pid,
      usage,
      payload: params as Record<string, unknown> | undefined,
    };
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<ProtocolMessage> {
    const id = this.nextId++;
    const msg = JSON.stringify({ id, method, params });
    this.process!.stdin!.write(msg + '\n');

    return new Promise<ProtocolMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ResponseTimeoutError());
      }, this.codexConfig.readTimeoutMs);

      const check = () => {
        const idx = this.messageQueue.findIndex((m) => m.id === id);
        if (idx !== -1) {
          clearTimeout(timer);
          resolve(this.messageQueue.splice(idx, 1)[0]!);
        } else {
          this.messageResolvers.push((m) => {
            if (m.id === id) {
              clearTimeout(timer);
              resolve(m);
              return;
            }
            this.messageQueue.push(m);
          });
        }
      };
      check();
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    const msg = JSON.stringify({ method, params });
    this.process!.stdin!.write(msg + '\n');
  }

  private sendResponse(id: number | string | unknown, result: Record<string, unknown>): void {
    const msg = JSON.stringify({ id, result });
    this.process!.stdin!.write(msg + '\n');
  }

  private waitForMessage(timeoutMs: number): Promise<ProtocolMessage> {
    if (this.messageQueue.length > 0) {
      return Promise.resolve(this.messageQueue.shift()!);
    }

    return new Promise<ProtocolMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ResponseTimeoutError());
      }, timeoutMs);

      this.messageResolvers.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: ProtocolMessage;
    try {
      msg = JSON.parse(trimmed) as ProtocolMessage;
    } catch {
      this.onEvent({
        event: 'malformed',
        timestamp: new Date(),
        codexAppServerPid: this.pid,
        payload: { raw: trimmed.slice(0, 200) },
      });
      return;
    }

    // Check if any resolvers are waiting
    if (this.messageResolvers.length > 0) {
      const resolver = this.messageResolvers.shift()!;
      resolver(msg);
    } else {
      this.messageQueue.push(msg);
    }
  }

  async stop(): Promise<void> {
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }
    if (this.process) {
      this.process.kill('SIGTERM');
      // Give it a moment to exit cleanly
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.process?.kill('SIGKILL');
          resolve();
        }, 5000);
        this.process!.on('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.process = null;
    }
  }

  kill(): void {
    this.process?.kill('SIGKILL');
  }
}
