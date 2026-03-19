import { Issue } from '../model/issue.js';
import { ServiceConfig } from '../model/workflow.js';
import { OrchestratorState } from '../model/orchestrator.js';

export function sortForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    // Priority ascending (1..4 preferred; null sorts last)
    const pa = a.priority ?? Infinity;
    const pb = b.priority ?? Infinity;
    if (pa !== pb) return pa - pb;

    // Oldest creation time first
    const ca = a.createdAt?.getTime() ?? Infinity;
    const cb = b.createdAt?.getTime() ?? Infinity;
    if (ca !== cb) return ca - cb;

    // Identifier lexicographic tie-breaker
    return a.identifier.localeCompare(b.identifier);
  });
}

export function isDispatchEligible(
  issue: Issue,
  state: OrchestratorState,
  config: ServiceConfig,
): boolean {
  // Must have required fields
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
    return false;
  }

  const normalizedState = issue.state.toLowerCase();
  const activeStates = config.tracker.activeStates.map((s) => s.toLowerCase());
  const terminalStates = config.tracker.terminalStates.map((s) => s.toLowerCase());

  // Must be in active states and not in terminal states
  if (!activeStates.includes(normalizedState)) return false;
  if (terminalStates.includes(normalizedState)) return false;

  // Must not be already running or claimed
  if (state.running.has(issue.id)) return false;
  if (state.claimed.has(issue.id)) return false;

  // Global concurrency check
  if (!hasGlobalSlots(state)) return false;

  // Per-state concurrency check
  if (!hasStateSlots(issue.state, state, config)) return false;

  // Blocker rule: Todo issues with non-terminal blockers are not eligible
  if (normalizedState === 'todo' && hasNonTerminalBlockers(issue, config)) return false;

  return true;
}

export function hasGlobalSlots(state: OrchestratorState): boolean {
  return state.running.size < state.maxConcurrentAgents;
}

export function hasStateSlots(
  issueState: string,
  state: OrchestratorState,
  config: ServiceConfig,
): boolean {
  const normalizedState = issueState.toLowerCase();
  const limit = config.agent.maxConcurrentAgentsByState[normalizedState];
  if (limit === undefined) return true; // No per-state limit

  let count = 0;
  for (const entry of state.running.values()) {
    if (entry.issue.state.toLowerCase() === normalizedState) {
      count++;
    }
  }

  return count < limit;
}

function hasNonTerminalBlockers(issue: Issue, config: ServiceConfig): boolean {
  const terminalStates = config.tracker.terminalStates.map((s) => s.toLowerCase());

  for (const blocker of issue.blockedBy) {
    if (blocker.state === null || !terminalStates.includes(blocker.state.toLowerCase())) {
      return true;
    }
  }

  return false;
}

export function availableSlots(state: OrchestratorState): number {
  return Math.max(state.maxConcurrentAgents - state.running.size, 0);
}
