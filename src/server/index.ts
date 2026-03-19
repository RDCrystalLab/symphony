import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Orchestrator, OrchestratorSnapshot } from '../orchestrator/orchestrator.js';
import { logger } from '../logging/logger.js';

export function startHttpServer(orchestrator: Orchestrator, port: number): void {
  const server = createServer((req, res) => {
    void handleRequest(req, res, orchestrator);
  });

  const host = '127.0.0.1';
  server.listen(port, host, () => {
    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : port;
    logger.info({ port: boundPort }, `HTTP server listening on ${host}:${boundPort}`);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  orchestrator: Orchestrator,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  try {
    if (path === '/' && req.method === 'GET') {
      return serveDashboard(res, orchestrator);
    }

    if (path === '/api/v1/state' && req.method === 'GET') {
      return serveJson(res, 200, orchestrator.getSnapshot());
    }

    if (path === '/api/v1/refresh' && req.method === 'POST') {
      orchestrator.triggerRefresh();
      return serveJson(res, 202, {
        queued: true,
        coalesced: false,
        requestedAt: new Date().toISOString(),
        operations: ['poll', 'reconcile'],
      });
    }

    // /api/v1/<identifier> - issue detail
    const identifierMatch = path.match(/^\/api\/v1\/([A-Za-z0-9_-]+)$/);
    if (identifierMatch && req.method === 'GET') {
      const identifier = identifierMatch[1]!;
      return serveIssueDetail(res, orchestrator, identifier);
    }

    // Method not allowed on known routes
    if (path === '/api/v1/state' || path === '/api/v1/refresh') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'method_not_allowed', message: 'Method not allowed' } }));
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }));
  } catch (err) {
    logger.error({ err }, 'HTTP request error');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'internal_error', message: 'Internal server error' } }));
  }
}

function serveJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function serveIssueDetail(
  res: ServerResponse,
  orchestrator: Orchestrator,
  identifier: string,
): void {
  const snapshot = orchestrator.getSnapshot();
  const running = snapshot.running.find((r) => r.issueIdentifier === identifier);
  const retrying = snapshot.retrying.find((r) => r.issueIdentifier === identifier);

  if (!running && !retrying) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'issue_not_found', message: `Issue ${identifier} not found in current state` } }));
    return;
  }

  const detail = {
    issueIdentifier: identifier,
    issueId: running?.issueId ?? retrying?.issueId,
    status: running ? 'running' : 'retrying',
    running: running ?? null,
    retry: retrying ?? null,
  };

  serveJson(res, 200, detail);
}

function serveDashboard(res: ServerResponse, orchestrator: Orchestrator): void {
  const snapshot = orchestrator.getSnapshot();

  const runningRows = snapshot.running.map((r) =>
    `<tr>
      <td>${escapeHtml(r.issueIdentifier)}</td>
      <td>${escapeHtml(r.state)}</td>
      <td>${r.turnCount}</td>
      <td>${escapeHtml(r.lastEvent ?? '-')}</td>
      <td>${r.tokens.totalTokens.toLocaleString()}</td>
      <td>${escapeHtml(r.startedAt)}</td>
    </tr>`
  ).join('\n');

  const retryRows = snapshot.retrying.map((r) =>
    `<tr>
      <td>${escapeHtml(r.issueIdentifier)}</td>
      <td>${r.attempt}</td>
      <td>${escapeHtml(r.dueAt)}</td>
      <td>${escapeHtml(r.error ?? '-')}</td>
    </tr>`
  ).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Symphony Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #f5f5f5; }
    h1 { color: #333; }
    .stats { display: flex; gap: 2rem; margin: 1rem 0; }
    .stat { background: white; padding: 1rem 2rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .stat-value { font-size: 2rem; font-weight: bold; color: #2563eb; }
    .stat-label { color: #666; font-size: 0.875rem; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin: 1rem 0; }
    th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f8fafc; font-weight: 600; color: #374151; }
    .section { margin: 2rem 0; }
    .refresh-btn { background: #2563eb; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; }
    .refresh-btn:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <h1>Symphony Dashboard</h1>
  <p>Generated at ${escapeHtml(snapshot.generatedAt)}</p>
  <button class="refresh-btn" onclick="fetch('/api/v1/refresh',{method:'POST'}).then(()=>location.reload())">Refresh</button>

  <div class="stats">
    <div class="stat"><div class="stat-value">${snapshot.counts.running}</div><div class="stat-label">Running</div></div>
    <div class="stat"><div class="stat-value">${snapshot.counts.retrying}</div><div class="stat-label">Retrying</div></div>
    <div class="stat"><div class="stat-value">${snapshot.codexTotals.totalTokens.toLocaleString()}</div><div class="stat-label">Total Tokens</div></div>
    <div class="stat"><div class="stat-value">${snapshot.codexTotals.secondsRunning.toFixed(1)}s</div><div class="stat-label">Runtime</div></div>
  </div>

  <div class="section">
    <h2>Running Sessions (${snapshot.counts.running})</h2>
    <table>
      <thead><tr><th>Issue</th><th>State</th><th>Turns</th><th>Last Event</th><th>Tokens</th><th>Started</th></tr></thead>
      <tbody>${runningRows || '<tr><td colspan="6">No running sessions</td></tr>'}</tbody>
    </table>
  </div>

  <div class="section">
    <h2>Retry Queue (${snapshot.counts.retrying})</h2>
    <table>
      <thead><tr><th>Issue</th><th>Attempt</th><th>Due At</th><th>Error</th></tr></thead>
      <tbody>${retryRows || '<tr><td colspan="4">No retries queued</td></tr>'}</tbody>
    </table>
  </div>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
