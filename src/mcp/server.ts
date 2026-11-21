import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

export interface EditorMcpServer {
  url: string;
  token: string;
  dispose(): Promise<void>;
}

/** Hook so stage 2 can register tools without touching the HTTP plumbing. */
export type ToolRegistrar = (server: McpServer) => void;

/** Handle one stateless MCP request and buffer its bounded JSON response. */
export async function handleEditorMcpRequest(register: ToolRegistrar, request: Request): Promise<Response> {
  const mcp = new McpServer({ name: 'forge-editor', version: '0.1.0' });
  register(mcp);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await mcp.connect(transport);
    const response = await transport.handleRequest(request);
    return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
  } finally {
    await transport.close();
    await mcp.close();
  }
}

/**
 * Starts a stateless streamable-HTTP MCP server on 127.0.0.1 (random free port).
 * TrueForge connects to REMOTE MCP servers by URL, so this is how editor
 * capabilities reach the agent. A random bearer token (kept in memory only)
 * stops other local processes from calling editor tools.
 */
export async function startEditorMcpServer(register: ToolRegistrar): Promise<EditorMcpServer> {
  const token = randomBytes(24).toString('hex');

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (req.url !== '/mcp') return send(res, 404, 'not found');
      if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, 'unauthorized');
      if (req.method !== 'POST') return send(res, 405, 'method not allowed'); // stateless: no SSE GET channel

      const body = await readJson(req);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) value.forEach((part) => headers.append(name, part));
        else if (value !== undefined) headers.set(name, value);
      }
      const request = new Request(new URL(req.url ?? '/mcp', `http://${req.headers.host ?? '127.0.0.1'}`), {
        method: req.method,
        headers,
        body: JSON.stringify(body),
      });
      const response = await handleEditorMcpRequest(register, request);
      const responseBody = Buffer.from(await response.arrayBuffer());
      const responseHeaders = Object.fromEntries(response.headers.entries());
      delete responseHeaders['transfer-encoding'];
      delete responseHeaders['content-length'];
      res.writeHead(response.status, { ...responseHeaders, 'Content-Length': responseBody.byteLength });
      res.end(responseBody);
    } catch (err) {
      if (!res.headersSent) send(res, 500, err instanceof Error ? err.message : 'error');
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve); // port 0 = OS picks a free port
  });
  const { port } = httpServer.address() as { port: number };

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    dispose: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

function send(res: http.ServerResponse, status: number, msg: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain' }).end(msg);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
