import { OrchestratorState } from '../model/orchestrator.js';
import { RetryEntry } from '../model/session.js';
import { logger } from '../logging/logger.js';

const CONTINUATION_DELAY_MS = 1000;
const BASE_FAILURE_DELAY_MS = 10000;

export function computeRetryDelay(
  attempt: number,
  maxBackoffMs: number,
  isContinuation: boolean,
): number {
  if (isContinuation) return CONTINUATION_DELAY_MS;
  const delay = BASE_FAILURE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(delay, maxBackoffMs);
}

export function scheduleRetry(
  state: OrchestratorState,
  issueId: string,
  identifier: string,
  attempt: number,
  error: string | null,
  maxBackoffMs: number,
  isContinuation: boolean,
  onFired: (issueId: string) => void,
): OrchestratorState {
  // Cancel existing retry timer for same issue
  const existing = state.retryAttempts.get(issueId);
  if (existing) {
    clearTimeout(existing.timerHandle);
    state.retryAttempts.delete(issueId);
  }

  const delayMs = computeRetryDelay(attempt, maxBackoffMs, isContinuation);
  const dueAtMs = Date.now() + delayMs;

  const timerHandle = setTimeout(() => {
    onFired(issueId);
  }, delayMs);

  const entry: RetryEntry = {
    issueId,
    identifier,
    attempt,
    dueAtMs,
    timerHandle,
    error,
  };

  state.retryAttempts.set(issueId, entry);

  logger.info(
    { issueId, issueIdentifier: identifier, attempt, delayMs, isContinuation: String(isContinuation) },
    `retry scheduled attempt=${attempt} delay=${delayMs}ms`,
  );

  return state;
}

export function cancelRetry(state: OrchestratorState, issueId: string): void {
  const existing = state.retryAttempts.get(issueId);
  if (existing) {
    clearTimeout(existing.timerHandle);
    state.retryAttempts.delete(issueId);
  }
}

export function releaseClaimedIssue(state: OrchestratorState, issueId: string): void {
  cancelRetry(state, issueId);
  state.claimed.delete(issueId);
  state.running.delete(issueId);
}
