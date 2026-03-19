export interface LogContext {
  issueId?: string;
  issueIdentifier?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: LogLevel, ctx: LogContext, msg: string): string {
  const parts: string[] = [
    `ts=${formatTimestamp()}`,
    `level=${level}`,
  ];

  if (ctx.issueId) parts.push(`issue_id=${ctx.issueId}`);
  if (ctx.issueIdentifier) parts.push(`issue_identifier=${ctx.issueIdentifier}`);
  if (ctx.sessionId) parts.push(`session_id=${ctx.sessionId}`);

  for (const [key, value] of Object.entries(ctx)) {
    if (['issueId', 'issueIdentifier', 'sessionId', 'err'].includes(key)) continue;
    if (value !== undefined && value !== null) {
      parts.push(`${key}=${String(value)}`);
    }
  }

  parts.push(`msg=${msg}`);

  if (ctx.err) {
    const err = ctx.err;
    if (err instanceof Error) {
      parts.push(`error=${err.message}`);
    } else {
      parts.push(`error=${String(err)}`);
    }
  }

  return parts.join(' ');
}

class Logger {
  private level: LogLevel = 'info';
  private output: (line: string) => void = (line) => process.stderr.write(line + '\n');

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setOutput(output: (line: string) => void): void {
    this.output = output;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.level);
  }

  debug(ctx: LogContext, msg: string): void {
    if (this.shouldLog('debug')) this.output(formatMessage('debug', ctx, msg));
  }

  info(ctx: LogContext, msg: string): void {
    if (this.shouldLog('info')) this.output(formatMessage('info', ctx, msg));
  }

  warn(ctx: LogContext, msg: string): void {
    if (this.shouldLog('warn')) this.output(formatMessage('warn', ctx, msg));
  }

  error(ctx: LogContext, msg: string): void {
    if (this.shouldLog('error')) this.output(formatMessage('error', ctx, msg));
  }

  child(defaultCtx: LogContext): ChildLogger {
    return new ChildLogger(this, defaultCtx);
  }
}

class ChildLogger {
  constructor(
    private parent: Logger,
    private defaultCtx: LogContext,
  ) {}

  debug(ctx: LogContext, msg: string): void {
    this.parent.debug({ ...this.defaultCtx, ...ctx }, msg);
  }

  info(ctx: LogContext, msg: string): void {
    this.parent.info({ ...this.defaultCtx, ...ctx }, msg);
  }

  warn(ctx: LogContext, msg: string): void {
    this.parent.warn({ ...this.defaultCtx, ...ctx }, msg);
  }

  error(ctx: LogContext, msg: string): void {
    this.parent.error({ ...this.defaultCtx, ...ctx }, msg);
  }
}

export const logger = new Logger();
