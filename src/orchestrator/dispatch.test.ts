import { describe, it, expect } from 'vitest';
import { sortForDispatch, isDispatchEligible } from './dispatch.js';
import { Issue } from '../model/issue.js';
import { OrchestratorState, createInitialState } from '../model/orchestrator.js';
import { buildConfig } from '../config/index.js';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'id-1',
    identifier: 'MT-1',
    title: 'Test issue',
    description: null,
    priority: 2,
    state: 'Todo',
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: new Date('2026-01-01'),
    updatedAt: null,
    ...overrides,
  };
}

describe('sortForDispatch', () => {
  it('sorts by priority ascending, null last', () => {
    const issues = [
      makeIssue({ id: 'a', priority: 3 }),
      makeIssue({ id: 'b', priority: 1 }),
      makeIssue({ id: 'c', priority: null }),
      makeIssue({ id: 'd', priority: 2 }),
    ];

    const sorted = sortForDispatch(issues);
    expect(sorted.map((i) => i.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('breaks priority ties by oldest createdAt', () => {
    const issues = [
      makeIssue({ id: 'a', priority: 1, createdAt: new Date('2026-03-01') }),
      makeIssue({ id: 'b', priority: 1, createdAt: new Date('2026-01-01') }),
    ];

    const sorted = sortForDispatch(issues);
    expect(sorted.map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('breaks createdAt ties by identifier', () => {
    const issues = [
      makeIssue({ id: 'a', identifier: 'MT-200', priority: 1, createdAt: new Date('2026-01-01') }),
      makeIssue({ id: 'b', identifier: 'MT-100', priority: 1, createdAt: new Date('2026-01-01') }),
    ];

    const sorted = sortForDispatch(issues);
    expect(sorted.map((i) => i.id)).toEqual(['b', 'a']);
  });
});

describe('isDispatchEligible', () => {
  const config = buildConfig({
    tracker: {
      kind: 'linear',
      api_key: 'test',
      project_slug: 'proj',
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done', 'Cancelled'],
    },
  });

  it('dispatches an eligible Todo issue', () => {
    const state = createInitialState(30000, 10);
    const issue = makeIssue({ state: 'Todo' });

    expect(isDispatchEligible(issue, state, config)).toBe(true);
  });

  it('rejects already running issue', () => {
    const state = createInitialState(30000, 10);
    state.running.set('id-1', {} as any);
    const issue = makeIssue();

    expect(isDispatchEligible(issue, state, config)).toBe(false);
  });

  it('rejects already claimed issue', () => {
    const state = createInitialState(30000, 10);
    state.claimed.add('id-1');
    const issue = makeIssue();

    expect(isDispatchEligible(issue, state, config)).toBe(false);
  });

  it('rejects when global slots exhausted', () => {
    const state = createInitialState(30000, 1);
    state.running.set('other', {} as any);
    const issue = makeIssue();

    expect(isDispatchEligible(issue, state, config)).toBe(false);
  });

  it('rejects Todo issue with non-terminal blockers', () => {
    const state = createInitialState(30000, 10);
    const issue = makeIssue({
      state: 'Todo',
      blockedBy: [{ id: 'b1', identifier: 'MT-2', state: 'In Progress' }],
    });

    expect(isDispatchEligible(issue, state, config)).toBe(false);
  });

  it('allows Todo issue with terminal blockers', () => {
    const state = createInitialState(30000, 10);
    const issue = makeIssue({
      state: 'Todo',
      blockedBy: [{ id: 'b1', identifier: 'MT-2', state: 'Done' }],
    });

    expect(isDispatchEligible(issue, state, config)).toBe(true);
  });

  it('rejects issue in terminal state', () => {
    const state = createInitialState(30000, 10);
    const issue = makeIssue({ state: 'Done' });

    expect(isDispatchEligible(issue, state, config)).toBe(false);
  });

  it('rejects issue not in active states', () => {
    const state = createInitialState(30000, 10);
    const issue = makeIssue({ state: 'Human Review' });

    expect(isDispatchEligible(issue, state, config)).toBe(false);
  });
});
