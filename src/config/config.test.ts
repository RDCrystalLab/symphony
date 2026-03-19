import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildConfig, validateDispatchConfig } from './index.js';

describe('Config Layer', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('applies defaults for empty config', () => {
    const config = buildConfig({});

    expect(config.tracker.kind).toBe('');
    expect(config.tracker.activeStates).toEqual(['Todo', 'In Progress']);
    expect(config.tracker.terminalStates).toEqual(['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done']);
    expect(config.polling.intervalMs).toBe(30000);
    expect(config.agent.maxConcurrentAgents).toBe(10);
    expect(config.agent.maxTurns).toBe(20);
    expect(config.agent.maxRetryBackoffMs).toBe(300000);
    expect(config.codex.command).toBe('codex app-server');
    expect(config.codex.turnTimeoutMs).toBe(3600000);
    expect(config.codex.readTimeoutMs).toBe(5000);
    expect(config.codex.stallTimeoutMs).toBe(300000);
    expect(config.hooks.timeoutMs).toBe(60000);
    expect(config.server.port).toBeNull();
  });

  it('resolves $VAR for tracker api_key', () => {
    process.env.MY_TOKEN = 'secret123';
    const config = buildConfig({
      tracker: { kind: 'linear', api_key: '$MY_TOKEN', project_slug: 'test' },
    });

    expect(config.tracker.apiKey).toBe('secret123');
  });

  it('resolves empty $VAR to empty string', () => {
    delete process.env.NONEXISTENT;
    const config = buildConfig({
      tracker: { kind: 'linear', api_key: '$NONEXISTENT', project_slug: 'test' },
    });

    expect(config.tracker.apiKey).toBe('');
  });

  it('parses per-state concurrency limits', () => {
    const config = buildConfig({
      agent: {
        max_concurrent_agents_by_state: {
          'Todo': 3,
          'In Progress': 5,
          'invalid': -1,
          'zero': 0,
        },
      },
    });

    expect(config.agent.maxConcurrentAgentsByState).toEqual({
      todo: 3,
      'in progress': 5,
    });
  });

  it('coerces string integers', () => {
    const config = buildConfig({
      polling: { interval_ms: '15000' },
      agent: { max_concurrent_agents: '3' },
    });

    expect(config.polling.intervalMs).toBe(15000);
    expect(config.agent.maxConcurrentAgents).toBe(3);
  });

  it('handles server.port extension', () => {
    const config = buildConfig({ server: { port: 8080 } });
    expect(config.server.port).toBe(8080);
  });

  it('hook timeout_ms falls back to 1 for non-positive', () => {
    const config = buildConfig({ hooks: { timeout_ms: -100 } });
    expect(config.hooks.timeoutMs).toBe(1);
  });
});

describe('Config Validation', () => {
  it('passes for valid linear config', () => {
    const config = buildConfig({
      tracker: { kind: 'linear', api_key: 'test-token', project_slug: 'proj' },
    });
    const result = validateDispatchConfig(config);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails when tracker.kind is missing', () => {
    const config = buildConfig({});
    const result = validateDispatchConfig(config);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('tracker.kind is required');
  });

  it('fails for unsupported tracker kind', () => {
    const config = buildConfig({
      tracker: { kind: 'jira', api_key: 'token', project_slug: 'proj' },
    });
    const result = validateDispatchConfig(config);

    expect(result.ok).toBe(false);
    expect(result.errors.some((e: string) => e.includes('Unsupported tracker kind'))).toBe(true);
  });

  it('fails when api_key is empty', () => {
    const config = buildConfig({
      tracker: { kind: 'linear', api_key: '', project_slug: 'proj' },
    });
    const result = validateDispatchConfig(config);

    expect(result.ok).toBe(false);
    expect(result.errors.some((e: string) => e.includes('api_key'))).toBe(true);
  });

  it('fails when project_slug is missing for linear', () => {
    const config = buildConfig({
      tracker: { kind: 'linear', api_key: 'token' },
    });
    const result = validateDispatchConfig(config);

    expect(result.ok).toBe(false);
    expect(result.errors.some((e: string) => e.includes('project_slug'))).toBe(true);
  });
});
