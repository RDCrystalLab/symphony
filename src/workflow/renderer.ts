import { Liquid } from 'liquidjs';
import { Issue } from '../model/issue.js';
import { TemplateParseError, TemplateRenderError } from '../model/errors.js';

const DEFAULT_PROMPT = 'You are working on an issue from Linear.';

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
});

export interface PromptContext {
  issue: Record<string, unknown>;
  attempt: number | null;
}

function issueToTemplateObject(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branchName,
    url: issue.url,
    labels: issue.labels,
    blocked_by: issue.blockedBy.map((b) => ({
      id: b.id,
      identifier: b.identifier,
      state: b.state,
    })),
    created_at: issue.createdAt?.toISOString() ?? null,
    updated_at: issue.updatedAt?.toISOString() ?? null,
  };
}

export async function renderPrompt(
  promptTemplate: string,
  issue: Issue,
  attempt: number | null,
): Promise<string> {
  if (!promptTemplate) {
    return DEFAULT_PROMPT;
  }

  const context: PromptContext = {
    issue: issueToTemplateObject(issue),
    attempt,
  };

  try {
    const result = await engine.parseAndRender(promptTemplate, context);
    return result;
  } catch (err) {
    if (err instanceof Error && err.message.includes('parse')) {
      throw new TemplateParseError(err.message, err);
    }
    throw new TemplateRenderError(
      `Failed to render prompt template: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}
