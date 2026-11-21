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
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-test-'));
    resetToolRunState();
    server = new McpServer({ name: 'test-editor', version: '1.0.0' });
    registerEditorTools(server, mockApi);
    fileContent = 'line 1\nline 2\nline 3\n';
    appliedProposal = undefined;
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
});
