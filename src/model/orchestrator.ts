import { Issue } from './issue.js';
import { LiveSession, RetryEntry } from './session.js';
import { ChildProcess } from 'node:child_process';

export interface RunningEntry {
  workerHandle: ChildProcess | null;
  identifier: string;
  issue: Issue;
  session: LiveSession | null;
  retryAttempt: number;
  startedAt: Date;
}

export interface CodexTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
}

export interface OrchestratorState {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retryAttempts: Map<string, RetryEntry>;
  completed: Set<string>;
  codexTotals: CodexTotals;
  codexRateLimits: Record<string, unknown> | null;
}

export function createInitialState(pollIntervalMs: number, maxConcurrentAgents: number): OrchestratorState {
  return {
    pollIntervalMs,
    maxConcurrentAgents,
    running: new Map(),
    claimed: new Set(),
    retryAttempts: new Map(),
    completed: new Set(),
    codexTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: 0,
    },
    codexRateLimits: null,
  };
}
