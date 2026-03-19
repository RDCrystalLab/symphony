import { Issue } from '../model/issue.js';
import { ServiceConfig, WorkflowDefinition } from '../model/workflow.js';
import {
  OrchestratorState,
  RunningEntry,
  createInitialState,
} from '../model/orchestrator.js';
import { buildConfig, validateDispatchConfig } from '../config/index.js';
import { fetchCandidateIssues, fetchIssuesByStates } from '../tracker/linear.js';
import { cleanTerminalWorkspaces } from '../workspace/manager.js';
import { runAgentAttempt, WorkerResult } from '../agent/runner.js';
import { CodexEvent } from '../agent/protocol.js';
import { sortForDispatch, isDispatchEligible, availableSlots } from './dispatch.js';
import { scheduleRetry, releaseClaimedIssue } from './retry.js';
import { reconcileRunningIssues } from './reconciliation.js';
import { logger } from '../logging/logger.js';

export class Orchestrator {
  private state: OrchestratorState;
  private config: ServiceConfig;
  private promptTemplate: string;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(workflow: WorkflowDefinition) {
    this.config = buildConfig(workflow.config);
    this.promptTemplate = workflow.promptTemplate;
    this.state = createInitialState(
      this.config.polling.intervalMs,
      this.config.agent.maxConcurrentAgents,
    );
  }

  async start(): Promise<void> {
    // Validate config
    const validation = validateDispatchConfig(this.config);
    if (!validation.ok) {
      throw new Error(`Startup validation failed: ${validation.errors.join('; ')}`);
    }

    this.running = true;

    // Startup terminal workspace cleanup
    await this.startupTerminalCleanup();

    // Schedule first tick immediately
    this.scheduleTick(0);

    logger.info({}, 'orchestrator started');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }

    // Cancel all retry timers
    for (const [, entry] of this.state.retryAttempts) {
      clearTimeout(entry.timerHandle);
    }
    this.state.retryAttempts.clear();

    // Note: we don't forcefully terminate running workers on graceful shutdown.
    // The service process exit will handle that.

    logger.info({}, 'orchestrator stopped');
  }

  reloadWorkflow(workflow: WorkflowDefinition): void {
    const newConfig = buildConfig(workflow.config);
    const validation = validateDispatchConfig(newConfig);

    if (!validation.ok) {
      logger.error({ errors: validation.errors.join('; ') }, 'workflow reload validation failed, keeping last good config');
      return;
    }

    this.config = newConfig;
    this.promptTemplate = workflow.promptTemplate;

    // Re-apply dynamic settings
    this.state.pollIntervalMs = this.config.polling.intervalMs;
    this.state.maxConcurrentAgents = this.config.agent.maxConcurrentAgents;

    logger.info({}, 'workflow config reloaded');
  }

  getSnapshot(): OrchestratorSnapshot {
    const running = Array.from(this.state.running.entries()).map(([id, entry]) => ({
      issueId: id,
      issueIdentifier: entry.identifier,
      state: entry.issue.state,
      sessionId: entry.session?.sessionId ?? null,
      turnCount: entry.session?.turnCount ?? 0,
      lastEvent: entry.session?.lastCodexEvent ?? null,
      lastMessage: entry.session?.lastCodexMessage ?? null,
      startedAt: entry.startedAt.toISOString(),
      lastEventAt: entry.session?.lastCodexTimestamp?.toISOString() ?? null,
      tokens: {
        inputTokens: entry.session?.codexInputTokens ?? 0,
        outputTokens: entry.session?.codexOutputTokens ?? 0,
        totalTokens: entry.session?.codexTotalTokens ?? 0,
      },
    }));

    const retrying = Array.from(this.state.retryAttempts.entries()).map(([id, entry]) => ({
      issueId: id,
      issueIdentifier: entry.identifier,
      attempt: entry.attempt,
      dueAt: new Date(entry.dueAtMs).toISOString(),
      error: entry.error,
    }));

    // Compute live seconds_running
    const now = Date.now();
    let activeSeconds = 0;
    for (const entry of this.state.running.values()) {
      activeSeconds += (now - entry.startedAt.getTime()) / 1000;
    }

    return {
      generatedAt: new Date().toISOString(),
      counts: { running: running.length, retrying: retrying.length },
      running,
      retrying,
      codexTotals: {
        inputTokens: this.state.codexTotals.inputTokens,
        outputTokens: this.state.codexTotals.outputTokens,
        totalTokens: this.state.codexTotals.totalTokens,
        secondsRunning: this.state.codexTotals.secondsRunning + activeSeconds,
      },
      rateLimits: this.state.codexRateLimits,
    };
  }

  triggerRefresh(): void {
    // Cancel existing tick and run immediately
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    this.scheduleTick(0);
  }

  // --- Private ---

  private scheduleTick(delayMs: number): void {
    if (!this.running) return;
    this.tickTimer = setTimeout(() => {
      void this.onTick();
    }, delayMs);
  }

  private async onTick(): Promise<void> {
    if (!this.running) return;

    try {
      // 1. Reconcile
      await reconcileRunningIssues(this.state, this.config, (issueId) => {
        this.terminateWorker(issueId);
      });

      // 2. Validate
      const validation = validateDispatchConfig(this.config);
      if (!validation.ok) {
        logger.error({ errors: validation.errors.join('; ') }, 'dispatch validation failed, skipping dispatch');
        this.scheduleTick(this.state.pollIntervalMs);
        return;
      }

      // 3. Fetch candidates
      let candidates: Issue[];
      try {
        candidates = await fetchCandidateIssues(this.config.tracker);
      } catch (err) {
        logger.error({ err }, 'candidate fetch failed, skipping dispatch');
        this.scheduleTick(this.state.pollIntervalMs);
        return;
      }

      // 4. Sort
      const sorted = sortForDispatch(candidates);

      // 5. Dispatch
      for (const issue of sorted) {
        if (availableSlots(this.state) <= 0) break;
        if (isDispatchEligible(issue, this.state, this.config)) {
          this.dispatchIssue(issue, null);
        }
      }
    } catch (err) {
      logger.error({ err }, 'tick error');
    }

    // 6. Schedule next tick
    this.scheduleTick(this.state.pollIntervalMs);
  }

  private dispatchIssue(issue: Issue, attempt: number | null): void {
    const issueId = issue.id;

    // Claim
    this.state.claimed.add(issueId);

    // Remove from retry if present
    const existingRetry = this.state.retryAttempts.get(issueId);
    if (existingRetry) {
      clearTimeout(existingRetry.timerHandle);
      this.state.retryAttempts.delete(issueId);
    }

    // Create running entry
    const entry: RunningEntry = {
      workerHandle: null,
      identifier: issue.identifier,
      issue,
      session: null,
      retryAttempt: attempt ?? 0,
      startedAt: new Date(),
    };
    this.state.running.set(issueId, entry);

    logger.info(
      { issueId, issueIdentifier: issue.identifier, attempt },
      'dispatching issue',
    );

    // Run the agent in the background
    void this.runWorker(issue, attempt);
  }

  private async runWorker(issue: Issue, attempt: number | null): Promise<void> {
    const issueId = issue.id;

    try {
      const result = await runAgentAttempt(
        issue,
        attempt,
        this.promptTemplate,
        this.config,
        (event) => this.handleCodexEvent(issueId, event),
      );

      this.onWorkerExit(issueId, result);
    } catch (err) {
      this.onWorkerExit(issueId, {
        issueId,
        issueIdentifier: issue.identifier,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        turnCount: 0,
      });
    }
  }

  private handleCodexEvent(issueId: string, event: CodexEvent): void {
    const entry = this.state.running.get(issueId);
    if (!entry || !entry.session) {
      // Session not fully initialized yet, create minimal session
      if (entry && !entry.session) {
        entry.session = {
          sessionId: '',
          threadId: '',
          turnId: '',
          codexAppServerPid: event.codexAppServerPid,
          lastCodexEvent: event.event,
          lastCodexTimestamp: event.timestamp,
          lastCodexMessage: null,
          codexInputTokens: 0,
          codexOutputTokens: 0,
          codexTotalTokens: 0,
          lastReportedInputTokens: 0,
          lastReportedOutputTokens: 0,
          lastReportedTotalTokens: 0,
          turnCount: 0,
        };
      }
      if (!entry) return;
    }

    const session = entry.session!;
    session.lastCodexEvent = event.event;
    session.lastCodexTimestamp = event.timestamp;
    session.codexAppServerPid = event.codexAppServerPid;

    if (event.payload) {
      const msg = String(event.payload.message ?? event.payload.text ?? '');
      if (msg) session.lastCodexMessage = msg.slice(0, 200);
    }

    // Token accounting: prefer absolute totals
    if (event.usage) {
      const newInput = event.usage.inputTokens;
      const newOutput = event.usage.outputTokens;
      const newTotal = event.usage.totalTokens;

      // Compute deltas from last reported
      const deltaInput = Math.max(0, newInput - session.lastReportedInputTokens);
      const deltaOutput = Math.max(0, newOutput - session.lastReportedOutputTokens);
      const deltaTotal = Math.max(0, newTotal - session.lastReportedTotalTokens);

      session.codexInputTokens = newInput;
      session.codexOutputTokens = newOutput;
      session.codexTotalTokens = newTotal;

      session.lastReportedInputTokens = newInput;
      session.lastReportedOutputTokens = newOutput;
      session.lastReportedTotalTokens = newTotal;

      // Accumulate to orchestrator totals
      this.state.codexTotals.inputTokens += deltaInput;
      this.state.codexTotals.outputTokens += deltaOutput;
      this.state.codexTotals.totalTokens += deltaTotal;
    }

    // Rate limits
    if (event.payload?.rateLimits || event.payload?.rate_limits) {
      this.state.codexRateLimits = (event.payload.rateLimits ?? event.payload.rate_limits) as Record<string, unknown>;
    }
  }

  private onWorkerExit(issueId: string, result: WorkerResult): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    // Add runtime seconds
    const runtimeSec = (Date.now() - entry.startedAt.getTime()) / 1000;
    this.state.codexTotals.secondsRunning += runtimeSec;

    // Remove from running
    this.state.running.delete(issueId);

    logger.info(
      { issueId, issueIdentifier: result.issueIdentifier, success: String(result.success), turnCount: result.turnCount },
      `worker exited: ${result.success ? 'normal' : result.error ?? 'unknown error'}`,
    );

    if (result.success) {
      // Normal exit: schedule continuation retry
      this.state.completed.add(issueId);
      scheduleRetry(
        this.state,
        issueId,
        result.issueIdentifier,
        1,
        null,
        this.config.agent.maxRetryBackoffMs,
        true,
        (id) => void this.onRetryTimer(id),
      );
    } else {
      // Abnormal exit: exponential backoff
      const nextAttempt = (entry.retryAttempt || 0) + 1;
      scheduleRetry(
        this.state,
        issueId,
        result.issueIdentifier,
        nextAttempt,
        result.error ?? 'unknown error',
        this.config.agent.maxRetryBackoffMs,
        false,
        (id) => void this.onRetryTimer(id),
      );
    }
  }

  private async onRetryTimer(issueId: string): Promise<void> {
    const retryEntry = this.state.retryAttempts.get(issueId);
    if (!retryEntry) return;

    this.state.retryAttempts.delete(issueId);

    // Fetch candidates to check if issue is still eligible
    let candidates: Issue[];
    try {
      candidates = await fetchCandidateIssues(this.config.tracker);
    } catch {
      // Re-queue
      scheduleRetry(
        this.state,
        issueId,
        retryEntry.identifier,
        retryEntry.attempt + 1,
        'retry poll failed',
        this.config.agent.maxRetryBackoffMs,
        false,
        (id) => void this.onRetryTimer(id),
      );
      return;
    }

    const issue = candidates.find((i) => i.id === issueId);
    if (!issue) {
      // Issue no longer active
      releaseClaimedIssue(this.state, issueId);
      logger.info({ issueId, issueIdentifier: retryEntry.identifier }, 'retry: issue no longer active, releasing claim');
      return;
    }

    if (availableSlots(this.state) <= 0) {
      // No slots, requeue
      scheduleRetry(
        this.state,
        issueId,
        retryEntry.identifier,
        retryEntry.attempt + 1,
        'no available orchestrator slots',
        this.config.agent.maxRetryBackoffMs,
        false,
        (id) => void this.onRetryTimer(id),
      );
      return;
    }

    // Re-dispatch
    this.dispatchIssue(issue, retryEntry.attempt);
  }

  private terminateWorker(issueId: string): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    // Kill the process if we had a handle
    if (entry.workerHandle) {
      try { entry.workerHandle.kill('SIGTERM'); } catch { /* ignore */ }
    }

    // Add runtime
    const runtimeSec = (Date.now() - entry.startedAt.getTime()) / 1000;
    this.state.codexTotals.secondsRunning += runtimeSec;

    // Remove
    this.state.running.delete(issueId);
    this.state.claimed.delete(issueId);
  }

  private async startupTerminalCleanup(): Promise<void> {
    try {
      const terminalIssues = await fetchIssuesByStates(
        this.config.tracker,
        this.config.tracker.terminalStates,
      );
      const identifiers = terminalIssues.map((i) => i.identifier);
      await cleanTerminalWorkspaces(this.config.workspace.root, identifiers, this.config.hooks);
      logger.info({ count: identifiers.length }, 'startup terminal workspace cleanup complete');
    } catch (err) {
      logger.warn({ err }, 'startup terminal cleanup failed, continuing');
    }
  }
}

export interface OrchestratorSnapshot {
  generatedAt: string;
  counts: { running: number; retrying: number };
  running: Array<{
    issueId: string;
    issueIdentifier: string;
    state: string;
    sessionId: string | null;
    turnCount: number;
    lastEvent: string | null;
    lastMessage: string | null;
    startedAt: string;
    lastEventAt: string | null;
    tokens: { inputTokens: number; outputTokens: number; totalTokens: number };
  }>;
  retrying: Array<{
    issueId: string;
    issueIdentifier: string;
    attempt: number;
    dueAt: string;
    error: string | null;
  }>;
  codexTotals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    secondsRunning: number;
  };
  rateLimits: Record<string, unknown> | null;
}
