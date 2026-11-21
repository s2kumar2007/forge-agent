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

    // 12 unique read-only calls (read_file, search_workspace)
    for (let i = 1; i <= 12; i++) {
      let res: any;
      if (i % 2 === 1) {
        res = await c.callTool({ name: 'read_file', arguments: { path: 'large.txt', start: i, end: i } });
      } else {
        res = await c.callTool({ name: 'search_workspace', arguments: { query: `query_${i}`, kind: 'text' } });
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

describe('loop breaker (ITEM 3)', () => {
  it('returns duplicate message without re-running on identical arguments, resetting on next run', async () => {
    resetToolRunState();
    let commandRuns = 0;
    const trackingApi: EditorApi = {
      ...api,
      runCommand: async (cmd) => {
        commandRuns++;
        return { exitCode: 0, output: `ran ${cmd}`, timedOut: false };
      },
    };

    const server = new McpServer({ name: 't3', version: '0' });
    registerEditorTools(server, trackingApi);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'c3', version: '0' });
    await Promise.all([server.connect(a), c.connect(b)]);

    // 1. read_file duplicate
    const read1: any = await c.callTool({ name: 'read_file', arguments: { path: 'a.py', start: 1, end: 1 } });
    expect(text(read1)).toContain('def hello():');
    const read2: any = await c.callTool({ name: 'read_file', arguments: { path: 'a.py', start: 1, end: 1 } });
    expect(text(read2)).toBe('Duplicate call: use the earlier result and continue.');
    expect(read2.isError).toBeFalsy();

    // 2. search_workspace duplicate
    const search1: any = await c.callTool({ name: 'search_workspace', arguments: { query: 'hello', kind: 'text' } });
    expect(text(search1)).toMatch(/a\.py:1/);
    const search2: any = await c.callTool({ name: 'search_workspace', arguments: { query: 'hello', kind: 'text' } });
    expect(text(search2)).toBe('Duplicate call: use the earlier result and continue.');

    // 3. list_dir duplicate
    const list1: any = await c.callTool({ name: 'list_dir', arguments: { path: '.' } });
    expect(text(list1)).toContain('a.py');
    const list2: any = await c.callTool({ name: 'list_dir', arguments: { path: '.' } });
    expect(text(list2)).toBe('Duplicate call: use the earlier result and continue.');

    // 4. run_command duplicate does NOT re-run underlying command
    expect(commandRuns).toBe(0);
    const cmd1: any = await c.callTool({ name: 'run_command', arguments: { command: 'echo test' } });
    expect(commandRuns).toBe(1);
    expect(text(cmd1)).toContain('ran echo test');

    const cmd2: any = await c.callTool({ name: 'run_command', arguments: { command: 'echo test' } });
    expect(commandRuns).toBe(1); // Crucial: did NOT re-run
    expect(text(cmd2)).toBe('Duplicate call: use the earlier result and continue.');

    // 5. Reset at start of next run allows execution again
    resetToolRunState();
    const cmd3: any = await c.callTool({ name: 'run_command', arguments: { command: 'echo test' } });
    expect(commandRuns).toBe(2);
    expect(text(cmd3)).toContain('ran echo test');
  });
});

describe('read_file outline option (ITEM 1)', () => {
  it('returns top-level and class-level definitions with name, kind, and start line', async () => {
    resetToolRunState();
    const pyCode = [
      'def top_function():',
      '    return 42',
      '',
      'class Calculator:',
      '    def __init__(self):',
      '        self.value = 0',
      '    def add(self, x):',
      '        def helper(): pass',
      '        self.value += x',
      '',
      'async def async_worker():',
      '    pass',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'calc.py'), pyCode);

    const tsCode = [
      'export interface User { id: string; }',
      'export class UserService {',
      '  getUser() { return null; }',
      '  private helper() {}',
      '}',
      'export function getUserCount() { return 1; }',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'user.ts'), tsCode);

    const c = await connect();

    // Python outline
    const pyRes: any = await c.callTool({ name: 'read_file', arguments: { path: 'calc.py', outline: true } });
    expect(pyRes.isError).toBeFalsy();
    const pyText = text(pyRes);
    expect(pyText).toContain('calc.py outline');
    expect(pyText).toContain('def top_function line 1');
    expect(pyText).toContain('class Calculator line 4');
    expect(pyText).toContain('def __init__ line 5');
    expect(pyText).toContain('def add line 7');
    expect(pyText).toContain('def async_worker line 11');
    expect(pyText).not.toContain('helper'); // inner function inside method is not class-level

    // TypeScript outline
    const tsRes: any = await c.callTool({ name: 'read_file', arguments: { path: 'user.ts', outline: true } });
    expect(tsRes.isError).toBeFalsy();
    const tsText = text(tsRes);
    expect(tsText).toContain('interface User line 1');
    expect(tsText).toContain('class UserService line 2');
    expect(tsText).toContain('method getUser line 3');
    expect(tsText).toContain('method helper line 4');
    expect(tsText).toContain('function getUserCount line 6');
  });

  it('caps outline at 200 entries', async () => {
    resetToolRunState();
    const manyDefs = Array.from({ length: 250 }, (_, i) => `def func_${i}(): pass`).join('\n');
    fs.writeFileSync(path.join(dir, 'many.py'), manyDefs);

    const c = await connect();
    const res: any = await c.callTool({ name: 'read_file', arguments: { path: 'many.py', outline: true } });
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('200 definitions');
    expect(out).toContain('def func_0 line 1');
    expect(out).toContain('def func_199 line 200');
    expect(out).not.toContain('def func_200 line 201');
  });

  it('counts outline as one read-only call toward exploration budget', async () => {
    resetToolRunState();
    setExplorationBudget(1);
    const c = await connect();

    // 1st call consumes the budget
    const r1: any = await c.callTool({ name: 'read_file', arguments: { path: 'calc.py', outline: true } });
    expect(r1.isError).toBeFalsy();

    // 2nd call is blocked by exploration budget
    const r2: any = await c.callTool({ name: 'read_file', arguments: { path: 'calc.py', start: 1, end: 2 } });
    expect(r2.isError).toBe(true);
    expect(text(r2)).toContain('Exploration budget reached');

    setExplorationBudget(12);
    resetToolRunState();
  });

  it('is backward compatible when outline is omitted or false', async () => {
    resetToolRunState();
    const c = await connect();
    const r: any = await c.callTool({ name: 'read_file', arguments: { path: 'a.py', start: 1, end: 1 } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('def hello():');
  });
});
