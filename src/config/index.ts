import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  ServiceConfig,
  TrackerConfig,
  PollingConfig,
  WorkspaceConfig,
  HooksConfig,
  AgentConfig,
  CodexConfig,
  ServerConfig,
} from '../model/workflow.js';
import {
  MissingTrackerApiKeyError,
  MissingTrackerProjectSlugError,
  UnsupportedTrackerKindError,
  SymphonyError,
} from '../model/errors.js';

function resolveEnvVar(value: string): string {
  if (value.startsWith('$')) {
    const varName = value.slice(1);
    return process.env[varName] ?? '';
  }
  return value;
}

function expandPath(value: string): string {
  if (value.startsWith('~')) {
    return join(homedir(), value.slice(1));
  }
  return resolveEnvVar(value);
}

function toInt(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const num = typeof value === 'string' ? parseInt(value, 10) : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toStr(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function toStrOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return String(value);
}

function toStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.map(String);
}

function parsePerStateConcurrency(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const num = Number(val);
    if (Number.isFinite(num) && num > 0) {
      result[key.toLowerCase()] = Math.floor(num);
    }
  }
  return result;
}

export function buildConfig(raw: Record<string, unknown>): ServiceConfig {
  const tracker = (raw.tracker ?? {}) as Record<string, unknown>;
  const polling = (raw.polling ?? {}) as Record<string, unknown>;
  const workspace = (raw.workspace ?? {}) as Record<string, unknown>;
  const hooks = (raw.hooks ?? {}) as Record<string, unknown>;
  const agent = (raw.agent ?? {}) as Record<string, unknown>;
  const codex = (raw.codex ?? {}) as Record<string, unknown>;
  const server = (raw.server ?? {}) as Record<string, unknown>;

  const trackerKind = toStr(tracker.kind, '');
  const trackerApiKeyRaw = toStr(tracker.api_key, '$LINEAR_API_KEY');
  const trackerApiKey = resolveEnvVar(trackerApiKeyRaw);

  const defaultEndpoint = trackerKind === 'linear' ? 'https://api.linear.app/graphql' : '';
  const workspaceRootRaw = toStr(workspace.root, join(tmpdir(), 'symphony_workspaces'));

  const trackerConfig: TrackerConfig = {
    kind: trackerKind,
    endpoint: toStr(tracker.endpoint, defaultEndpoint),
    apiKey: trackerApiKey,
    projectSlug: toStr(tracker.project_slug, ''),
    activeStates: toStringList(tracker.active_states, ['Todo', 'In Progress']),
    terminalStates: toStringList(tracker.terminal_states, ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done']),
  };

  const pollingConfig: PollingConfig = {
    intervalMs: toInt(polling.interval_ms, 30000),
  };

  const workspaceConfig: WorkspaceConfig = {
    root: expandPath(workspaceRootRaw),
  };

  const hooksConfig: HooksConfig = {
    afterCreate: toStrOrNull(hooks.after_create),
    beforeRun: toStrOrNull(hooks.before_run),
    afterRun: toStrOrNull(hooks.after_run),
    beforeRemove: toStrOrNull(hooks.before_remove),
    timeoutMs: Math.max(toInt(hooks.timeout_ms, 60000), 1),
  };

  const agentConfig: AgentConfig = {
    maxConcurrentAgents: toInt(agent.max_concurrent_agents, 10),
    maxTurns: toInt(agent.max_turns, 20),
    maxRetryBackoffMs: toInt(agent.max_retry_backoff_ms, 300000),
    maxConcurrentAgentsByState: parsePerStateConcurrency(agent.max_concurrent_agents_by_state),
  };

  const codexConfig: CodexConfig = {
    command: toStr(codex.command, 'codex app-server'),
    approvalPolicy: toStr(codex.approval_policy, 'auto-edit'),
    threadSandbox: toStr(codex.thread_sandbox, 'none'),
    turnSandboxPolicy: toStr(codex.turn_sandbox_policy, 'none'),
    turnTimeoutMs: toInt(codex.turn_timeout_ms, 3600000),
    readTimeoutMs: toInt(codex.read_timeout_ms, 5000),
    stallTimeoutMs: toInt(codex.stall_timeout_ms, 300000),
  };

  const serverConfig: ServerConfig = {
    port: server.port !== undefined ? toInt(server.port, 0) : null,
  };

  return {
    tracker: trackerConfig,
    polling: pollingConfig,
    workspace: workspaceConfig,
    hooks: hooksConfig,
    agent: agentConfig,
    codex: codexConfig,
    server: serverConfig,
  };
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateDispatchConfig(config: ServiceConfig): ValidationResult {
  const errors: string[] = [];

  if (!config.tracker.kind) {
    errors.push('tracker.kind is required');
  } else if (config.tracker.kind !== 'linear') {
    errors.push(`Unsupported tracker kind: ${config.tracker.kind}`);
  }

  if (!config.tracker.apiKey) {
    errors.push('tracker.api_key is missing or empty after $VAR resolution');
  }

  if (config.tracker.kind === 'linear' && !config.tracker.projectSlug) {
    errors.push('tracker.project_slug is required for Linear');
  }

  if (!config.codex.command) {
    errors.push('codex.command must be present and non-empty');
  }

  return { ok: errors.length === 0, errors };
}
