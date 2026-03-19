import { Issue, BlockerRef } from '../model/issue.js';
import { TrackerConfig } from '../model/workflow.js';
import {
  LinearApiRequestError,
  LinearApiStatusError,
  LinearGraphQLError,
} from '../model/errors.js';
import { logger } from '../logging/logger.js';

const PAGE_SIZE = 50;
const NETWORK_TIMEOUT_MS = 30000;

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  state: { name: string };
  branchName?: string | null;
  url?: string | null;
  labels?: { nodes: Array<{ name: string }> };
  inverseRelations?: { nodes: Array<{ type: string; issue: { id: string; identifier: string; state: { name: string } } }> };
  createdAt?: string | null;
  updatedAt?: string | null;
}

function normalizeIssue(node: LinearIssueNode): Issue {
  const blockedBy: BlockerRef[] = [];
  if (node.inverseRelations?.nodes) {
    for (const rel of node.inverseRelations.nodes) {
      if (rel.type === 'blocks') {
        blockedBy.push({
          id: rel.issue.id,
          identifier: rel.issue.identifier,
          state: rel.issue.state.name,
        });
      }
    }
  }

  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? null,
    priority: typeof node.priority === 'number' ? node.priority : null,
    state: node.state.name,
    branchName: node.branchName ?? null,
    url: node.url ?? null,
    labels: (node.labels?.nodes ?? []).map((l) => l.name.toLowerCase()),
    blockedBy,
    createdAt: node.createdAt ? new Date(node.createdAt) : null,
    updatedAt: node.updatedAt ? new Date(node.updatedAt) : null,
  };
}

async function graphql(
  config: TrackerConfig,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);

  try {
    const resp = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': config.apiKey,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new LinearApiStatusError(resp.status, body);
    }

    const json = await resp.json() as { data?: Record<string, unknown>; errors?: unknown[] };

    if (json.errors && json.errors.length > 0) {
      throw new LinearGraphQLError(json.errors);
    }

    return json.data ?? {};
  } catch (err) {
    if (err instanceof LinearApiStatusError || err instanceof LinearGraphQLError) throw err;
    throw new LinearApiRequestError(
      `Linear API request failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  } finally {
    clearTimeout(timer);
  }
}

const CANDIDATE_QUERY = `
  query CandidateIssues($projectSlug: String!, $states: [String!]!, $after: String) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $states } }
      }
      first: ${PAGE_SIZE}
      after: $after
    ) {
      nodes {
        id
        identifier
        title
        description
        priority
        state { name }
        branchName
        url
        labels { nodes { name } }
        inverseRelations { nodes { type issue { id identifier state { name } } } }
        createdAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export async function fetchCandidateIssues(config: TrackerConfig): Promise<Issue[]> {
  const issues: Issue[] = [];
  let cursor: string | null = null;

  while (true) {
    const variables: Record<string, unknown> = {
      projectSlug: config.projectSlug,
      states: config.activeStates,
    };
    if (cursor) variables.after = cursor;

    const data = await graphql(config, CANDIDATE_QUERY, variables);
    const issuesData = data.issues as {
      nodes: LinearIssueNode[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };

    for (const node of issuesData.nodes) {
      issues.push(normalizeIssue(node));
    }

    if (!issuesData.pageInfo.hasNextPage) break;
    if (!issuesData.pageInfo.endCursor) {
      logger.warn({}, 'Linear pagination: hasNextPage=true but endCursor is null');
      break;
    }
    cursor = issuesData.pageInfo.endCursor;
  }

  return issues;
}

const STATES_BY_IDS_QUERY = `
  query IssueStatesByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Issue {
        id
        identifier
        title
        state { name }
      }
    }
  }
`;

export interface IssueStateResult {
  id: string;
  identifier: string;
  title: string;
  state: string;
}

export async function fetchIssueStatesByIds(
  config: TrackerConfig,
  issueIds: string[],
): Promise<IssueStateResult[]> {
  if (issueIds.length === 0) return [];

  const data = await graphql(config, STATES_BY_IDS_QUERY, { ids: issueIds });
  const nodes = (data.nodes ?? []) as Array<{
    id: string;
    identifier: string;
    title: string;
    state: { name: string };
  }>;

  return nodes
    .filter((n) => n && n.id && n.state)
    .map((n) => ({
      id: n.id,
      identifier: n.identifier,
      title: n.title,
      state: n.state.name,
    }));
}

const ISSUES_BY_STATES_QUERY = `
  query IssuesByStates($projectSlug: String!, $states: [String!]!, $after: String) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $states } }
      }
      first: ${PAGE_SIZE}
      after: $after
    ) {
      nodes {
        id
        identifier
        state { name }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export async function fetchIssuesByStates(
  config: TrackerConfig,
  states: string[],
): Promise<Array<{ id: string; identifier: string; state: string }>> {
  if (states.length === 0) return [];

  const results: Array<{ id: string; identifier: string; state: string }> = [];
  let cursor: string | null = null;

  while (true) {
    const variables: Record<string, unknown> = {
      projectSlug: config.projectSlug,
      states,
    };
    if (cursor) variables.after = cursor;

    const data = await graphql(config, ISSUES_BY_STATES_QUERY, variables);
    const issuesData = data.issues as {
      nodes: Array<{ id: string; identifier: string; state: { name: string } }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };

    for (const node of issuesData.nodes) {
      results.push({ id: node.id, identifier: node.identifier, state: node.state.name });
    }

    if (!issuesData.pageInfo.hasNextPage) break;
    if (!issuesData.pageInfo.endCursor) break;
    cursor = issuesData.pageInfo.endCursor;
  }

  return results;
}

export async function executeLinearGraphQL(
  config: TrackerConfig,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  if (!query || typeof query !== 'string') {
    return { success: false, error: 'query must be a non-empty string' };
  }

  if (!config.apiKey) {
    return { success: false, error: 'Linear auth not configured' };
  }

  try {
    const data = await graphql(config, query, variables ?? {});
    return { success: true, data };
  } catch (err) {
    if (err instanceof LinearGraphQLError) {
      return { success: false, data: err.message, error: err.message };
    }
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
