import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerEditorTools, resetToolRunState, setExplorationBudget } from '../src/mcp/tools';
import type { EditorApi } from '../src/workspace/types';
import { rgText } from '../src/workspace/ripgrep';

const rg = path.resolve(`node_modules/@vscode/ripgrep-${process.platform}-${process.arch}/bin/${process.platform === 'win32' ? 'rg.exe' : 'rg'}`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'));
fs.writeFileSync(path.join(dir, 'a.py'), 'def hello():\n    return 1\n');
const writes: string[] = [];
const candidates: string[] = [];

const api: EditorApi = {
  root: () => dir,
  readText: async (abs) => (fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined),
  listDir: async (abs) => fs.readdirSync(abs, { withFileTypes: true }).map((d) => ({ name: d.name, type: d.isDirectory() ? 'dir' : 'file' })),
  searchText: (q) => rgText(rg, dir, q),
  searchSymbols: async () => [],
  runCommand: async () => ({ exitCode: 0, output: 'ok', timedOut: false }),
  applyProposal: async (abs, candidate) => { writes.push(abs); candidates.push(candidate); return 'REFUSED: not reviewed'; },
};

async function connect() {
  const server = new McpServer({ name: 't', version: '0' });
  registerEditorTools(server, api);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const text = (r: any) => r.content.map((c: any) => c.text).join('\n');

describe('MCP editor tools', () => {
  it('lists the five tools', async () => {
    const c = await connect();
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(['list_dir', 'propose_write', 'read_file', 'run_command', 'search_workspace']);
  });
  it('reads a line slice and refuses paths outside the workspace', async () => {
    const c = await connect();
    expect(text(await c.callTool({ name: 'read_file', arguments: { path: 'a.py', start: 2, end: 2 } }))).toContain('    return 1');
    const bad: any = await c.callTool({ name: 'read_file', arguments: { path: '../../etc/passwd' } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('Refused');
  });
  it('searches with ranked results and a why', async () => {
    const c = await connect();
    expect(text(await c.callTool({ name: 'search_workspace', arguments: { query: 'hello', kind: 'text' } }))).toMatch(/a\.py:1.*why:/);
  });
  it('propose_write only reaches the reviewed-apply path and never writes by itself', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'propose_write', arguments: { path: 'a.py', new_content: 'x', rationale: 'r' } });
    expect(text(r)).toContain('REFUSED');
    expect(fs.readFileSync(path.join(dir, 'a.py'), 'utf8')).toContain('def hello');
  });
});

it('materializes exact MCP edits but still refuses an unreviewed write',async()=>{
 const client=await connect();const before=fs.readFileSync(path.join(dir,'a.py'),'utf8');
 const result=await client.callTool({name:'propose_write',arguments:{path:'a.py',rationale:'test',edits:[{old_text:'return 1',new_text:'return 2'}]}});
 expect(candidates.at(-1)).toBe(before.replace('return 1','return 2'));expect(text(result)).toContain('REFUSED');expect(fs.readFileSync(path.join(dir,'a.py'),'utf8')).toBe(before);
});

it('bounds large-file reads so model history cannot absorb a whole source file',async()=>{
 const large=Array.from({length:100},(_,i)=>'line '+(i+1)).join('\n');fs.writeFileSync(path.join(dir,'large.txt'),large);const c=await connect();
 const whole:any=await c.callTool({name:'read_file',arguments:{path:'large.txt'}});expect(whole.isError).toBe(true);expect(text(whole)).toContain('request a start/end range');
 const oversized:any=await c.callTool({name:'read_file',arguments:{path:'large.txt',start:1,end:81}});expect(oversized.isError).toBe(true);expect(text(oversized)).toContain('limited to 80 lines');
 const reversed:any=await c.callTool({name:'read_file',arguments:{path:'large.txt',start:20,end:10}});expect(reversed.isError).toBe(true);expect(text(reversed)).toContain('greater than or equal');
 const slice:any=await c.callTool({name:'read_file',arguments:{path:'large.txt',start:21,end:30}});expect(slice.isError).not.toBe(true);expect(text(slice)).toContain('lines 21-30 of 100');
});

describe('exploration budget in tools (ITEM 2)', () => {
  it('limits read-only tools to the exploration budget and never limits write or command', async () => {
    resetToolRunState();
    setExplorationBudget(12);
    const c = await connect();

    // 12 read-only calls (mix of read_file, search_workspace, list_dir)
    for (let i = 1; i <= 12; i++) {
      let res: any;
      if (i % 3 === 1) {
        res = await c.callTool({ name: 'read_file', arguments: { path: 'large.txt', start: i, end: i } });
      } else if (i % 3 === 2) {
        res = await c.callTool({ name: 'search_workspace', arguments: { query: `query_${i}`, kind: 'text' } });
      } else {
        res = await c.callTool({ name: 'list_dir', arguments: { path: '.' } });
      }
      expect(res.isError).toBeFalsy();
    }

    // 13th read-only call fails with exploration budget error
    const blockedRead: any = await c.callTool({ name: 'read_file', arguments: { path: 'a.py', start: 1, end: 1 } });
    expect(blockedRead.isError).toBe(true);
    expect(text(blockedRead)).toContain('Exploration budget reached. Call propose_write now for each target file.');

    const blockedSearch: any = await c.callTool({ name: 'search_workspace', arguments: { query: 'another', kind: 'text' } });
    expect(blockedSearch.isError).toBe(true);
    expect(text(blockedSearch)).toContain('Exploration budget reached. Call propose_write now for each target file.');

    const blockedList: any = await c.callTool({ name: 'list_dir', arguments: { path: '.' } });
    expect(blockedList.isError).toBe(true);
    expect(text(blockedList)).toContain('Exploration budget reached. Call propose_write now for each target file.');

    // propose_write and run_command are never limited
    const writeRes: any = await c.callTool({ name: 'propose_write', arguments: { path: 'a.py', new_content: 'ok', rationale: 'r' } });
    expect(writeRes.isError).toBeFalsy();

    const cmdRes: any = await c.callTool({ name: 'run_command', arguments: { command: 'echo ok' } });
    expect(cmdRes.isError).toBeFalsy();

    // Counter resets on next run
    resetToolRunState();
    const freshRead: any = await c.callTool({ name: 'read_file', arguments: { path: 'a.py', start: 1, end: 1 } });
    expect(freshRead.isError).toBeFalsy();
  });

  it('honors a custom exploration budget setting', async () => {
    resetToolRunState();
    setExplorationBudget(2);
    const c = await connect();

    const r1: any = await c.callTool({ name: 'read_file', arguments: { path: 'large.txt', start: 1, end: 2 } });
    expect(r1.isError).toBeFalsy();
    const r2: any = await c.callTool({ name: 'read_file', arguments: { path: 'large.txt', start: 3, end: 4 } });
    expect(r2.isError).toBeFalsy();

    // 3rd read exceeds budget of 2
    const r3: any = await c.callTool({ name: 'read_file', arguments: { path: 'large.txt', start: 5, end: 6 } });
    expect(r3.isError).toBe(true);
    expect(text(r3)).toContain('Exploration budget reached. Call propose_write now for each target file.');

    // Reset default
    setExplorationBudget(12);
    resetToolRunState();
  });
});
