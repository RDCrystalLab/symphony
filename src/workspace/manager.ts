import { mkdir, rm, stat, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Workspace } from '../model/workspace.js';
import { HooksConfig } from '../model/workflow.js';
import { InvalidWorkspaceCwdError } from '../model/errors.js';
import { logger } from '../logging/logger.js';

export function sanitizeIdentifier(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function getWorkspacePath(root: string, identifier: string): string {
  const key = sanitizeIdentifier(identifier);
  const wsPath = resolve(root, key);

  // Safety: ensure workspace path is under root
  const normalizedRoot = resolve(root);
  const normalizedWs = resolve(wsPath);
  if (!normalizedWs.startsWith(normalizedRoot + '/') && normalizedWs !== normalizedRoot) {
    throw new InvalidWorkspaceCwdError(`Workspace path ${normalizedWs} is outside root ${normalizedRoot}`);
  }

  return normalizedWs;
}

export async function createForIssue(
  root: string,
  identifier: string,
  hooks: HooksConfig,
): Promise<Workspace> {
  const key = sanitizeIdentifier(identifier);
  const wsPath = getWorkspacePath(root, identifier);

  let createdNow = false;

  try {
    const s = await stat(wsPath);
    if (!s.isDirectory()) {
      // Non-directory at path — remove and recreate
      await rm(wsPath, { force: true });
      await mkdir(wsPath, { recursive: true });
      createdNow = true;
    }
  } catch {
    // Does not exist
    await mkdir(wsPath, { recursive: true });
    createdNow = true;
  }

  if (createdNow && hooks.afterCreate) {
    await runHook('after_create', hooks.afterCreate, wsPath, hooks.timeoutMs);
  }

  return { path: wsPath, workspaceKey: key, createdNow };
}

export async function runHook(
  name: string,
  script: string,
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  logger.info({ hook: name, cwd }, `running hook ${name}`);

  return new Promise<void>((resolveP, reject) => {
    const child = spawn('sh', ['-lc', script], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Hook ${name} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const truncStderr = stderr.length > 500 ? stderr.slice(0, 500) + '...' : stderr;
        reject(new Error(`Hook ${name} failed with exit code ${code}: ${truncStderr}`));
      } else {
        resolveP();
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Hook ${name} error: ${err.message}`));
    });
  });
}

export async function cleanWorkspace(
  root: string,
  identifier: string,
  hooks: HooksConfig,
): Promise<void> {
  const wsPath = getWorkspacePath(root, identifier);

  try {
    await stat(wsPath);
  } catch {
    return; // Doesn't exist, nothing to clean
  }

  if (hooks.beforeRemove) {
    try {
      await runHook('before_remove', hooks.beforeRemove, wsPath, hooks.timeoutMs);
    } catch (err) {
      logger.warn({ err, workspace: wsPath }, 'before_remove hook failed, proceeding with cleanup');
    }
  }

  await rm(wsPath, { recursive: true, force: true });
  logger.info({ workspace: wsPath, identifier }, 'workspace cleaned');
}

export async function cleanTerminalWorkspaces(
  root: string,
  terminalIdentifiers: string[],
  hooks: HooksConfig,
): Promise<void> {
  for (const identifier of terminalIdentifiers) {
    try {
      await cleanWorkspace(root, identifier, hooks);
    } catch (err) {
      logger.warn({ err, identifier }, 'failed to clean terminal workspace');
    }
  }
}
