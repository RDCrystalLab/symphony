import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { WorkflowDefinition } from '../model/workflow.js';
import {
  MissingWorkflowFileError,
  WorkflowParseError,
  WorkflowFrontMatterNotAMapError,
} from '../model/errors.js';

const FRONT_MATTER_DELIMITER = '---';

export async function loadWorkflow(filePath: string): Promise<WorkflowDefinition> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MissingWorkflowFileError(filePath);
    }
    throw new WorkflowParseError(`Failed to read workflow file: ${filePath}`, err);
  }

  return parseWorkflowContent(content);
}

export function parseWorkflowContent(content: string): WorkflowDefinition {
  const lines = content.split('\n');
  let config: Record<string, unknown> = {};
  let promptTemplate: string;

  if (lines[0]?.trim() === FRONT_MATTER_DELIMITER) {
    const endIndex = findClosingDelimiter(lines);
    if (endIndex === -1) {
      throw new WorkflowParseError('Unclosed YAML front matter (missing closing ---)');
    }

    const yamlContent = lines.slice(1, endIndex).join('\n');
    let parsed: unknown;
    try {
      parsed = parseYaml(yamlContent);
    } catch (err) {
      throw new WorkflowParseError('Invalid YAML in front matter', err);
    }

    if (parsed === null || parsed === undefined) {
      config = {};
    } else if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new WorkflowFrontMatterNotAMapError();
    } else {
      config = parsed as Record<string, unknown>;
    }

    promptTemplate = lines.slice(endIndex + 1).join('\n').trim();
  } else {
    promptTemplate = content.trim();
  }

  return { config, promptTemplate };
}

function findClosingDelimiter(lines: string[]): number {
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === FRONT_MATTER_DELIMITER) {
      return i;
    }
  }
  return -1;
}
