#!/usr/bin/env node

import { resolve } from 'node:path';
import { WorkflowWatcher } from '../workflow/watcher.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { startHttpServer } from '../server/index.js';
import { logger } from '../logging/logger.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse args
  let workflowPath = resolve('WORKFLOW.md');
  let port: number | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--port' && i + 1 < args.length) {
      port = parseInt(args[++i]!, 10);
      if (isNaN(port)) {
        console.error('Error: --port requires a numeric argument');
        process.exit(1);
      }
    } else if (!arg.startsWith('-')) {
      workflowPath = resolve(arg);
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  logger.info({ workflowPath }, 'starting symphony');

  // Load and watch workflow
  const watcher = new WorkflowWatcher(workflowPath, (workflow) => {
    orchestrator.reloadWorkflow(workflow);
  });

  let workflow;
  try {
    workflow = await watcher.start();
  } catch (err) {
    logger.error({ err }, 'failed to load workflow');
    process.exit(1);
  }

  // Create orchestrator
  const orchestrator = new Orchestrator(workflow);

  // Start HTTP server if configured
  const { buildConfig } = await import('../config/index.js');
  const config = buildConfig(workflow.config);
  const effectivePort = port ?? config.server.port;
  if (effectivePort !== null) {
    startHttpServer(orchestrator, effectivePort);
  }

  // Handle shutdown
  const shutdown = async () => {
    logger.info({}, 'shutting down');
    await orchestrator.stop();
    await watcher.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Start orchestrator
  try {
    await orchestrator.start();
  } catch (err) {
    logger.error({ err }, 'orchestrator startup failed');
    await watcher.stop();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
