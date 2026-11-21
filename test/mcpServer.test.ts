import { describe, it, expect, afterAll } from 'vitest';
import { handleEditorMcpRequest, startEditorMcpServer } from '../src/mcp/server';

describe('editor MCP server', async () => {
  const srv = await startEditorMcpServer(() => {});
  afterAll(() => srv.dispose());

  it('binds to loopback only', () => {
    expect(srv.url.startsWith('http://127.0.0.1:')).toBe(true);
  });
  it('rejects calls without the bearer token', async () => {
    const r = await fetch(srv.url, { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
  });
  it('answers MCP initialize as JSON through the SDK transport', async () => {
    const response = await handleEditorMcpRequest(() => {}, new Request(srv.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${srv.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'forge-editor', version: '0.1.0' } },
    });
  });
});
