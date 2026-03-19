export class SymphonyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SymphonyError';
  }
}

// Workflow errors
export class MissingWorkflowFileError extends SymphonyError {
  constructor(path: string) {
    super('missing_workflow_file', `Workflow file not found: ${path}`);
  }
}

export class WorkflowParseError extends SymphonyError {
  constructor(message: string, cause?: unknown) {
    super('workflow_parse_error', message, cause);
  }
}

export class WorkflowFrontMatterNotAMapError extends SymphonyError {
  constructor() {
    super('workflow_front_matter_not_a_map', 'YAML front matter must decode to a map/object');
  }
}

export class TemplateParseError extends SymphonyError {
  constructor(message: string, cause?: unknown) {
    super('template_parse_error', message, cause);
  }
}

export class TemplateRenderError extends SymphonyError {
  constructor(message: string, cause?: unknown) {
    super('template_render_error', message, cause);
  }
}

// Tracker errors
export class UnsupportedTrackerKindError extends SymphonyError {
  constructor(kind: string) {
    super('unsupported_tracker_kind', `Unsupported tracker kind: ${kind}`);
  }
}

export class MissingTrackerApiKeyError extends SymphonyError {
  constructor() {
    super('missing_tracker_api_key', 'Tracker API key is missing or empty');
  }
}

export class MissingTrackerProjectSlugError extends SymphonyError {
  constructor() {
    super('missing_tracker_project_slug', 'Tracker project slug is required');
  }
}

export class LinearApiRequestError extends SymphonyError {
  constructor(message: string, cause?: unknown) {
    super('linear_api_request', message, cause);
  }
}

export class LinearApiStatusError extends SymphonyError {
  constructor(status: number, body: string) {
    super('linear_api_status', `Linear API returned status ${status}: ${body}`);
  }
}

export class LinearGraphQLError extends SymphonyError {
  constructor(errors: unknown[]) {
    super('linear_graphql_errors', `Linear GraphQL errors: ${JSON.stringify(errors)}`);
  }
}

// Agent errors
export class CodexNotFoundError extends SymphonyError {
  constructor(command: string) {
    super('codex_not_found', `Codex command not found: ${command}`);
  }
}

export class InvalidWorkspaceCwdError extends SymphonyError {
  constructor(path: string) {
    super('invalid_workspace_cwd', `Invalid workspace cwd: ${path}`);
  }
}

export class ResponseTimeoutError extends SymphonyError {
  constructor() {
    super('response_timeout', 'Response timeout waiting for app-server');
  }
}

export class TurnTimeoutError extends SymphonyError {
  constructor() {
    super('turn_timeout', 'Turn timeout exceeded');
  }
}

export class TurnInputRequiredError extends SymphonyError {
  constructor() {
    super('turn_input_required', 'Agent requested user input (not supported in automated mode)');
  }
}
