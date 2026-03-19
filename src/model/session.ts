export interface RunAttempt {
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  workspacePath: string;
  startedAt: Date;
  status: RunStatus;
  error?: string;
}

export type RunStatus =
  | 'preparing_workspace'
  | 'building_prompt'
  | 'launching_agent_process'
  | 'initializing_session'
  | 'streaming_turn'
  | 'finishing'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'stalled'
  | 'canceled_by_reconciliation';

export interface LiveSession {
  sessionId: string;
  threadId: string;
  turnId: string;
  codexAppServerPid: string | null;
  lastCodexEvent: string | null;
  lastCodexTimestamp: Date | null;
  lastCodexMessage: string | null;
  codexInputTokens: number;
  codexOutputTokens: number;
  codexTotalTokens: number;
  lastReportedInputTokens: number;
  lastReportedOutputTokens: number;
  lastReportedTotalTokens: number;
  turnCount: number;
}

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  timerHandle: ReturnType<typeof setTimeout>;
  error: string | null;
}
