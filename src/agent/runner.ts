import { Issue } from '../model/issue.js';
import { ServiceConfig } from '../model/workflow.js';
import { CodexEvent } from './protocol.js';
import { AppServerClient, CodexEventCallback } from './client.js';
import { renderPrompt } from '../workflow/renderer.js';
import * as workspace from '../workspace/manager.js';
import { logger } from '../logging/logger.js';

export interface WorkerResult {
  issueId: string;
  issueIdentifier: string;
  success: boolean;
  error?: string;
  turnCount: number;
}

export async function runAgentAttempt(
  issue: Issue,
  attempt: number | null,
  promptTemplate: string,
  config: ServiceConfig,
  onEvent: CodexEventCallback,
): Promise<WorkerResult> {
  const log = logger.child({
    issueId: issue.id,
    issueIdentifier: issue.identifier,
  });

  // 1. Create/reuse workspace
  const ws = await workspace.createForIssue(
    config.workspace.root,
    issue.identifier,
    config.hooks,
  );

  // 2. Run before_run hook
  if (config.hooks.beforeRun) {
    await workspace.runHook('before_run', config.hooks.beforeRun, ws.path, config.hooks.timeoutMs);
  }

  // 3. Start app-server session
  const client = new AppServerClient(
    config.codex,
    config.tracker.kind === 'linear' ? config.tracker : null,
    onEvent,
  );

  let turnCount = 0;

  try {
    await client.start(ws.path);
    const threadId = await client.startThread(ws.path);
    log.info({ sessionId: client.sessionId, threadId }, 'agent session started');

    onEvent({
      event: 'session_started',
      timestamp: new Date(),
      codexAppServerPid: client.pid,
    });

    const maxTurns = config.agent.maxTurns;

    for (let turnNumber = 1; turnNumber <= maxTurns; turnNumber++) {
      // Build prompt (full for first turn, continuation for subsequent)
      let prompt: string;
      if (turnNumber === 1) {
        prompt = await renderPrompt(promptTemplate, issue, attempt);
      } else {
        prompt = buildContinuationPrompt(issue, turnNumber, maxTurns);
      }

      // Start turn
      await client.startTurn(prompt, ws.path, `${issue.identifier}: ${issue.title}`);
      turnCount++;

      log.info({ sessionId: client.sessionId, turn: turnNumber }, `turn ${turnNumber} started`);

      // Stream turn until completion
      const result = await client.streamTurn();

      if (result.status === 'failed') {
        await client.stop();
        await runAfterRunHook(ws.path, config);
        return {
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          success: false,
          error: `turn_failed: ${result.error}`,
          turnCount,
        };
      }

      if (result.status === 'cancelled') {
        await client.stop();
        await runAfterRunHook(ws.path, config);
        return {
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          success: false,
          error: `turn_cancelled: ${result.reason}`,
          turnCount,
        };
      }

      // Turn completed — check if we should continue
      if (turnNumber >= maxTurns) {
        log.info({ sessionId: client.sessionId }, `max turns (${maxTurns}) reached`);
        break;
      }

      // The orchestrator handles issue state re-checking at the higher level.
      // For now, we break after one successful turn and let the orchestrator
      // decide whether to schedule a continuation.
      // Multi-turn within one worker session is supported but the turn loop
      // is controlled by the orchestrator's re-check pattern.
      break;
    }

    await client.stop();
    await runAfterRunHook(ws.path, config);

    return {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      success: true,
      turnCount,
    };
  } catch (err) {
    await client.stop().catch(() => {});
    await runAfterRunHook(ws.path, config);

    return {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      turnCount,
    };
  }
}

function buildContinuationPrompt(issue: Issue, turnNumber: number, maxTurns: number): string {
  return [
    `Continue working on ${issue.identifier}: ${issue.title}.`,
    `This is continuation turn ${turnNumber} of ${maxTurns}.`,
    'Review what was accomplished in the previous turn and continue from where you left off.',
    'If the task is complete, indicate that clearly.',
  ].join('\n');
}

async function runAfterRunHook(wsPath: string, config: ServiceConfig): Promise<void> {
  if (config.hooks.afterRun) {
    try {
      await workspace.runHook('after_run', config.hooks.afterRun, wsPath, config.hooks.timeoutMs);
    } catch (err) {
      logger.warn({ err, workspace: wsPath }, 'after_run hook failed (ignored)');
    }
  }
}
