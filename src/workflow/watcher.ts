import { watch, type FSWatcher } from 'chokidar';
import { loadWorkflow } from './loader.js';
import { WorkflowDefinition } from '../model/workflow.js';
import { logger } from '../logging/logger.js';

export type WorkflowChangeCallback = (workflow: WorkflowDefinition) => void;

export class WorkflowWatcher {
  private watcher: FSWatcher | null = null;
  private currentWorkflow: WorkflowDefinition | null = null;

  constructor(
    private readonly filePath: string,
    private readonly onChange: WorkflowChangeCallback,
  ) {}

  async start(): Promise<WorkflowDefinition> {
    this.currentWorkflow = await loadWorkflow(this.filePath);

    this.watcher = watch(this.filePath, {
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher.on('change', () => {
      void this.handleChange();
    });

    return this.currentWorkflow;
  }

  private async handleChange(): Promise<void> {
    try {
      const workflow = await loadWorkflow(this.filePath);
      this.currentWorkflow = workflow;
      logger.info({ path: this.filePath }, 'workflow reloaded');
      this.onChange(workflow);
    } catch (err) {
      logger.error({ err, path: this.filePath }, 'workflow reload failed, keeping last known good config');
    }
  }

  get workflow(): WorkflowDefinition | null {
    return this.currentWorkflow;
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
