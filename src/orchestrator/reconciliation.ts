import { OrchestratorState, RunningEntry } from '../model/orchestrator.js';
import { ServiceConfig } from '../model/workflow.js';
import { IssueStateResult, fetchIssueStatesByIds } from '../tracker/linear.js';
import { cleanWorkspace } from '../workspace/manager.js';
import { logger } from '../logging/logger.js';

export interface ReconcileActions {
  terminated: Array<{ issueId: string; reason: string; cleanWorkspace: boolean }>;
  updated: Array<{ issueId: string; newState: string }>;
}

export async function reconcileRunningIssues(
  state: OrchestratorState,
  config: ServiceConfig,
  terminateWorker: (issueId: string) => void,
): Promise<ReconcileActions> {
  const actions: ReconcileActions = { terminated: [], updated: [] };

  // Part A: Stall detection
  if (config.codex.stallTimeoutMs > 0) {
    const now = Date.now();
    for (const [issueId, entry] of state.running) {
      const lastActivity = entry.session?.lastCodexTimestamp ?? entry.startedAt;
      const elapsedMs = now - lastActivity.getTime();

      if (elapsedMs > config.codex.stallTimeoutMs) {
        logger.warn(
          { issueId, issueIdentifier: entry.identifier, elapsedMs },
          'stall detected, terminating worker',
        );
        terminateWorker(issueId);
        actions.terminated.push({ issueId, reason: 'stalled', cleanWorkspace: false });
      }
    }
  }

  // Part B: Tracker state refresh
  const runningIds = Array.from(state.running.keys());
  if (runningIds.length === 0) return actions;

  let refreshed: IssueStateResult[];
  try {
    refreshed = await fetchIssueStatesByIds(config.tracker, runningIds);
  } catch (err) {
    logger.debug({ err }, 'state refresh failed, keeping workers running');
    return actions;
  }

  const terminalStates = config.tracker.terminalStates.map((s) => s.toLowerCase());
  const activeStates = config.tracker.activeStates.map((s) => s.toLowerCase());

  for (const refreshedIssue of refreshed) {
    const normalizedState = refreshedIssue.state.toLowerCase();
    const entry = state.running.get(refreshedIssue.id);
    if (!entry) continue;

    if (terminalStates.includes(normalizedState)) {
      // Terminal: stop and clean workspace
      logger.info(
        { issueId: refreshedIssue.id, issueIdentifier: refreshedIssue.identifier, state: refreshedIssue.state },
        'issue is terminal, stopping worker and cleaning workspace',
      );
      terminateWorker(refreshedIssue.id);
      actions.terminated.push({ issueId: refreshedIssue.id, reason: 'terminal', cleanWorkspace: true });

      try {
        await cleanWorkspace(config.workspace.root, refreshedIssue.identifier, config.hooks);
      } catch (err) {
        logger.warn({ err, issueIdentifier: refreshedIssue.identifier }, 'workspace cleanup failed');
      }
    } else if (activeStates.includes(normalizedState)) {
      // Still active: update in-memory state
      entry.issue.state = refreshedIssue.state;
      actions.updated.push({ issueId: refreshedIssue.id, newState: refreshedIssue.state });
    } else {
      // Neither active nor terminal: stop without cleanup
      logger.info(
        { issueId: refreshedIssue.id, issueIdentifier: refreshedIssue.identifier, state: refreshedIssue.state },
        'issue is non-active, stopping worker (no workspace cleanup)',
      );
      terminateWorker(refreshedIssue.id);
      actions.terminated.push({ issueId: refreshedIssue.id, reason: 'non_active', cleanWorkspace: false });
    }
  }

  return actions;
}
