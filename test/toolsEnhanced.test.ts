import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerEditorTools, resetToolRunState } from '../src/mcp/tools';
import type { EditorApi } from '../src/workspace/types';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

describe('enhanced propose_write and stale file guard', () => {
  let root: string;
  let server: McpServer;
  let fileContent: string;
  let appliedProposal: string | undefined;

  const mockApi: EditorApi = {
    root: () => root,
    readText: async (abs: string) => {
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (rel === 'file.txt') return fileContent;
      return undefined;
    },
    listDir: async () => [],
    searchText: async () => [],
    searchSymbols: async () => [],
    runCommand: async () => ({ exitCode: 0, output: '', timedOut: false }),
    applyProposal: async (abs: string, candidate: string) => {
      appliedProposal = candidate;
      fileContent = candidate;
      return 'applied';
    },
  };

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tools-test-')));
    resetToolRunState();
    fileContent = 'line 1\nline 2\nline 3\n';
    await fs.writeFile(path.join(root, 'file.txt'), fileContent);
    appliedProposal = undefined;
    (mockApi as any).readText = async (abs: string) => {
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (rel === 'file.txt') return fileContent;
      return undefined;
    };
    server = new McpServer({ name: 'test-editor', version: '1.0.0' });
    registerEditorTools(server, mockApi, { includeAdvancedTools: true });
  });

  async function callTool(name: string, args: Record<string, unknown>) {
    const tool = (server as any)._registeredTools?.[name];
    if (!tool) throw new Error(`Tool ${name} not found`);
    return await tool.handler(args);
  }

  it('detects a stale file if content changed between read_file and propose_write', async () => {
    // 1. Read file
    const readRes = await callTool('read_file', { path: 'file.txt' });
    expect(readRes.isError).toBeFalsy();

    // 2. Modify file content behind the agent's back
    fileContent = 'line 1\nline 2 modified\nline 3\n';

    // 3. Propose write
    const writeRes = await callTool('propose_write', {
      path: 'file.txt',
      search: 'line 1\n',
      replace: 'line 1 updated\n',
      rationale: 'Update line 1',
    });

    expect(writeRes.isError).toBe(true);
    expect(writeRes.content[0].text).toContain('Stale file: "file.txt" was modified after it was read.');
  });

  it('succeeds with top-level search and replace in propose_write', async () => {
    await callTool('read_file', { path: 'file.txt' });

    const writeRes = await callTool('propose_write', {
      path: 'file.txt',
      search: 'line 2',
      replace: 'line TWO',
      rationale: 'Capitalize two',
    });

    expect(writeRes.isError).toBeFalsy();
    expect(appliedProposal).toBe('line 1\nline TWO\nline 3\n');
  });

  it('succeeds with line range replacement in propose_write', async () => {
    await callTool('read_file', { path: 'file.txt' });

    const writeRes = await callTool('propose_write', {
      path: 'file.txt',
      startLine: 1,
      endLine: 2,
      newText: 'first two lines replaced',
      rationale: 'Replace first two lines',
    });

    expect(writeRes.isError).toBeFalsy();
    expect(appliedProposal).toBe('first two lines replaced\nline 3\n');
  });

  it('supports propose_changes tool across multiple files atomically', async () => {
    const files: Record<string, string> = {
      'a.txt': 'apple\n',
      'b.txt': 'banana\n',
    };
    (mockApi as any).readText = async (abs: string) => {
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      return files[rel];
    };
    (mockApi as any).applyProposal = async (abs: string, candidate: string) => {
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      files[rel] = candidate;
      return 'applied';
    };

    const res = await callTool('propose_changes', {
      changes: [
        { path: 'a.txt', search: 'apple', replace: 'apricot', rationale: 'update a' },
        { path: 'b.txt', search: 'banana', replace: 'blueberry', rationale: 'update b' },
      ],
      rationale: 'Update both fruits',
    });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Applied changes to 2 file(s)');
    expect(files['a.txt']).toBe('apricot\n');
    expect(files['b.txt']).toBe('blueberry\n');
  });

  it('supports search_symbols with snippets and secret file filtering', async () => {
    (mockApi as any).searchSymbols = async () => [
      { name: 'calculate_total', kind: 'function', path: 'file.txt', line: 1 },
      { name: 'secret_fn', kind: 'function', path: '.env', line: 1 },
    ];

    const res = await callTool('search_symbols', { query: 'total' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('file.txt:1');
    expect(res.content[0].text).toContain('calculate_total');
    expect(res.content[0].text).toContain('line 1');
    expect(res.content[0].text).not.toContain('.env');
  });

  it('supports find_references with symbol usages and secret blocking', async () => {
    (mockApi as any).findReferences = async (abs: string, line?: number, symbol?: string) => [
      { path: 'file.txt', line: 2, text: 'const t = calculate_total();' },
    ];

    const res = await callTool('find_references', { path: 'file.txt', symbol: 'calculate_total' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('file.txt:2');
    expect(res.content[0].text).toContain('const t = calculate_total();');

    const blockedRes = await callTool('find_references', { path: '.env', symbol: 'KEY' });
    expect(blockedRes.isError).toBe(true);
    expect(blockedRes.content[0].text).toContain('blocked: secret-like file');
  });

  it('supports get_diagnostics formatting and severity filtering', async () => {
    (mockApi as any).getDiagnostics = async () => [
      { path: 'file.txt', line: 3, column: 5, severity: 'error', message: 'Syntax error', source: 'tsc' },
      { path: 'file.txt', line: 1, column: 1, severity: 'warning', message: 'Unused var', source: 'eslint' },
    ];

    const res = await callTool('get_diagnostics', { severity: 'all' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('[ERROR] file.txt:3:5 - Syntax error (tsc)');
    expect(res.content[0].text).toContain('[WARNING] file.txt:1:1 - Unused var (eslint)');
  });

  it('supports run_tests with auto-detection', async () => {
    let executedCmd: string | undefined;
    (mockApi as any).runCommand = async (cmd: string) => {
      executedCmd = cmd;
      return { exitCode: 0, output: '1 passed in 0.05s', timedOut: false };
    };

    const res = await callTool('run_tests', { framework: 'pytest', test_path: 'tests/test_helpers.py', filter: 'test_debug' });
    expect(res.isError).toBeFalsy();
    expect(executedCmd).toBe('pytest tests/test_helpers.py -k "test_debug"');
    expect(res.content[0].text).toContain('1 passed in 0.05s');
  });
});
