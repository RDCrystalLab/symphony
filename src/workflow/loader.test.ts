import { describe, it, expect } from 'vitest';
import { parseWorkflowContent } from './loader.js';

describe('Workflow Loader', () => {
  it('parses front matter and prompt body', () => {
    const content = `---
tracker:
  kind: linear
  project_slug: my-project
polling:
  interval_ms: 15000
---
You are working on {{ issue.identifier }}: {{ issue.title }}.`;

    const result = parseWorkflowContent(content);

    expect(result.config).toEqual({
      tracker: { kind: 'linear', project_slug: 'my-project' },
      polling: { interval_ms: 15000 },
    });
    expect(result.promptTemplate).toBe('You are working on {{ issue.identifier }}: {{ issue.title }}.');
  });

  it('handles file with no front matter', () => {
    const content = 'Just a prompt with no config.';
    const result = parseWorkflowContent(content);

    expect(result.config).toEqual({});
    expect(result.promptTemplate).toBe('Just a prompt with no config.');
  });

  it('handles empty front matter', () => {
    const content = `---
---
Some prompt.`;
    const result = parseWorkflowContent(content);

    expect(result.config).toEqual({});
    expect(result.promptTemplate).toBe('Some prompt.');
  });

  it('throws on non-map front matter', () => {
    const content = `---
- item1
- item2
---
Prompt.`;

    expect(() => parseWorkflowContent(content)).toThrow('front matter must decode to a map');
  });

  it('throws on unclosed front matter', () => {
    const content = `---
tracker:
  kind: linear
No closing delimiter.`;

    expect(() => parseWorkflowContent(content)).toThrow('Unclosed YAML front matter');
  });

  it('handles complex front matter with all config sections', () => {
    const content = `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: test-proj
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
polling:
  interval_ms: 60000
workspace:
  root: /tmp/workspaces
hooks:
  after_create: |
    git clone repo .
  before_run: echo "starting"
  timeout_ms: 30000
agent:
  max_concurrent_agents: 5
  max_turns: 10
  max_retry_backoff_ms: 120000
codex:
  command: codex app-server
  approval_policy: auto-edit
  turn_timeout_ms: 1800000
---
Work on {{ issue.identifier }}.
Attempt: {{ attempt }}.`;

    const result = parseWorkflowContent(content);

    expect(result.config.tracker).toBeDefined();
    expect((result.config.tracker as Record<string, unknown>).kind).toBe('linear');
    expect((result.config.agent as Record<string, unknown>).max_concurrent_agents).toBe(5);
    expect(result.promptTemplate).toContain('{{ issue.identifier }}');
    expect(result.promptTemplate).toContain('{{ attempt }}');
  });
});
