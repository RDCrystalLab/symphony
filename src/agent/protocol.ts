// JSON-RPC-like protocol message types for Codex app-server communication

export interface ProtocolMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface InitializeParams {
  clientInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
}

export interface ThreadStartParams {
  approvalPolicy: string;
  sandbox: string;
  cwd: string;
}

export interface TurnStartParams {
  threadId: string;
  input: Array<{ type: string; text: string }>;
  cwd: string;
  title: string;
  approvalPolicy: string;
  sandboxPolicy: { type: string };
}

export interface CodexEvent {
  event: string;
  timestamp: Date;
  codexAppServerPid: string | null;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  payload?: Record<string, unknown>;
}

export type TurnResult =
  | { status: 'completed' }
  | { status: 'failed'; error: string }
  | { status: 'cancelled'; reason: string }
  | { status: 'input_required' };
