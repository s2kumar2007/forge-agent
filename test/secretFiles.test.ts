import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isSecretPath } from '../src/workspace/paths';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerEditorTools } from '../src/mcp/tools';
import type { EditorApi } from '../src/workspace/types';
import { assembleContext, type ContextDeps } from '../src/context/assemble';

describe('isSecretPath pattern matching', () => {
  it.each([
    ['.env', '.env'],
    ['.env.* (local)', '.env.local'],
    ['.env.* (production)', '.env.production'],
    ['.env.* (test)', 'sub/.env.test'],
    ['*.pem (root)', 'server.pem'],
    ['*.pem (nested)', 'certs/cert.pem'],
    ['*.key (root)', 'private.key'],
    ['*.key (nested)', 'config/ssl.key'],
    ['id_rsa*', 'id_rsa'],
    ['id_rsa* (.pub)', 'id_rsa.pub'],
    ['id_rsa* (backup)', 'ssh/id_rsa_backup'],
    ['credentials*', 'credentials'],
    ['credentials* (.json)', 'credentials.json'],
    ['credentials* (.yaml)', 'auth/credentials.yaml'],
    ['*.p12 (root)', 'cert.p12'],
    ['*.p12 (nested)', 'keys/bundle.p12'],
    ['.git (root)', '.git'],
    ['.git (config)', '.git/config'],
    ['.git (nested)', 'sub/.git/HEAD'],
  ])('detects secret file %s (%s)', (_label, filePath) => {
    expect(isSecretPath(filePath)).toBe(true);
  });

  it.each([
    ['config.py', 'config.py'],
    ['src/config.py', 'src/config.py'],
    ['app.py', 'app.py'],
    ['package.json', 'package.json'],
    ['keyboard.ts', 'src/keyboard.ts'],
    ['api_key_helper.py', 'api_key_helper.py'],
    ['secrets_service.py', 'services/secrets_service.py'],
  ])('allows legitimate file %s (%s)', (_label, filePath) => {
    expect(isSecretPath(filePath)).toBe(false);
  });
});

describe('MCP tools secret blocking (ITEM 2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-tools-'));
  const secretNames = [
    '.env',
    '.env.local',
    'server.pem',
    'private.key',
    'id_rsa',
    'credentials.json',
    'cert.p12',
  ];

  for (const name of secretNames) {
    fs.writeFileSync(path.join(dir, name), `SECRET_TOKEN_${name}=12345\n`);
  }
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\nrepositoryformatversion = 0\n');
  fs.writeFileSync(path.join(dir, 'config.py'), 'APP_CONFIG = {"debug": True}\nSECRET_ALLOWED = 42\n');

  const api: EditorApi = {
    root: () => dir,
    readText: async (abs) => (fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined),
    listDir: async (abs) => fs.readdirSync(abs, { withFileTypes: true }).map((d) => ({ name: d.name, type: d.isDirectory() ? 'dir' : 'file' })),
    searchText: async (q) => {
      const results: { path: string; line: number; text: string }[] = [];
      for (const f of [...secretNames, '.git/config', 'config.py']) {
        const full = path.join(dir, f);
        if (fs.existsSync(full)) {
          const content = fs.readFileSync(full, 'utf8');
          content.split('\n').forEach((line, idx) => {
            if (line.includes(q)) results.push({ path: f, line: idx + 1, text: line });
          });
        }
      }
      return results;
    },
    searchSymbols: async () => [
      { name: 'SECRET_TOKEN', kind: 'variable', path: '.env', line: 1 },
      { name: 'APP_CONFIG', kind: 'variable', path: 'config.py', line: 1 },
    ],
    runCommand: async () => ({ exitCode: 0, output: 'ok', timedOut: false }),
    applyProposal: async () => 'REFUSED',
  };

  async function connect() {
    const server = new McpServer({ name: 't', version: '0' });
    registerEditorTools(server, api);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  const textOf = (r: any) => r.content.map((c: any) => c.text).join('\n');

  it('read_file returns "blocked: secret-like file" for each secret pattern', async () => {
    const client = await connect();
    for (const secret of [...secretNames, '.git/config']) {
      const res: any = await client.callTool({ name: 'read_file', arguments: { path: secret } });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe('blocked: secret-like file');
    }

    // Legitimate file config.py is allowed
    const okRes: any = await client.callTool({ name: 'read_file', arguments: { path: 'config.py' } });
    expect(okRes.isError).toBeFalsy();
    expect(textOf(okRes)).toContain('APP_CONFIG');
  });

  it('list_dir filters out all secret files and .git directory', async () => {
    const client = await connect();
    const res: any = await client.callTool({ name: 'list_dir', arguments: { path: '.' } });
    const output = textOf(res);
    for (const secret of secretNames) {
      expect(output).not.toContain(secret);
    }
    expect(output).not.toContain('.git');
    expect(output).toContain('config.py');
  });

  it('search_workspace filters out secret files for both text and symbol search', async () => {
    const client = await connect();

    // Text search matching secret files and config.py
    const textRes: any = await client.callTool({ name: 'search_workspace', arguments: { query: 'SECRET', kind: 'text' } });
    const textOut = textOf(textRes);
    expect(textOut).toContain('config.py');
    for (const secret of secretNames) {
      expect(textOut).not.toContain(secret);
    }
    expect(textOut).not.toContain('.git');

    // Symbol search matching secret files and config.py
    const symRes: any = await client.callTool({ name: 'search_workspace', arguments: { query: 'SECRET', kind: 'symbol' } });
    const symOut = textOf(symRes);
    expect(symOut).not.toContain('.env');
  });
});

describe('context assembly secret filtering (ITEM 2)', () => {
  it('excludes secret files from explicit mentions, ranked candidates, and repo map while allowing config.py', async () => {
    const files = [
      'config.py',
      '.env',
      '.env.local',
      'server.pem',
      'private.key',
      'id_rsa',
      'credentials.json',
      'cert.p12',
      '.git/config',
    ];
    const contents: Record<string, string> = {
      'config.py': 'def load_config():\n    return {}\n',
      '.env': 'SECRET_KEY=supersecret\n',
      'credentials.json': '{"token": "secret"}\n',
    };

    const deps: ContextDeps = {
      listFiles: async () => files,
      searchKeyword: async (k) => {
        const hits: { path: string; line: number; text: string }[] = [];
        if (k === 'config' || k === 'secret') {
          hits.push({ path: 'config.py', line: 1, text: 'def load_config():' });
          hits.push({ path: '.env', line: 1, text: 'SECRET_KEY=supersecret' });
          hits.push({ path: 'credentials.json', line: 1, text: '{"token": "secret"}' });
        }
        return hits;
      },
      searchImporters: async () => [],
      readText: async (rel) => contents[rel],
      findSymbol: async (name) => {
        if (name === 'SECRET_KEY') return { name: 'SECRET_KEY', kind: 'variable', path: '.env', line: 1 };
        if (name === 'load_config') return { name: 'load_config', kind: 'function', path: 'config.py', line: 1 };
        return undefined;
      },
    };

    // User explicitly attempts to mention @file:.env and @symbol:SECRET_KEY alongside legitimate config.py
    const prompt = 'Check @file:.env and @symbol:SECRET_KEY and also @file:config.py for config';
    const result = await assembleContext(prompt, deps, 2000);

    // .env and credentials must not appear anywhere in context text or items
    expect(result.text).not.toContain('.env');
    expect(result.text).not.toContain('credentials.json');
    expect(result.text).not.toContain('supersecret');
    expect(result.text).not.toContain('server.pem');
    expect(result.text).not.toContain('private.key');
    expect(result.text).not.toContain('id_rsa');
    expect(result.text).not.toContain('.git');

    // Legitimate config.py must be present
    expect(result.text).toContain('config.py');
    expect(result.items.some((i) => i.label.includes('config.py'))).toBe(true);
  });
});
