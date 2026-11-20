import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, it, expect, vi } from 'vitest';
import { estimateTokens, packContext } from '../src/context/budget';
import { assembleContext, windows, type ContextDeps } from '../src/context/assemble';
import { extractKeywords, parseMentions } from '../src/context/keywords';
import { topLevelSymbols } from '../src/context/symbols';
import { runRg } from '../src/workspace/ripgrep';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

describe('packContext (token budget)', () => {
  const item = (label: string, chars: number, priority: number) => ({ label, reason: 'r', text: ('x'.repeat(39) + '\n').repeat(chars / 40), priority });
  it('estimates ~4 chars per token', () => expect(estimateTokens('x'.repeat(400))).toBe(100));
  it('never exceeds the budget; higher priority first; truncates then drops', () => {
    const r = packContext([item('low', 4000, 1), item('high', 2000, 9), item('mid', 4000, 5)], 1000);
    expect(r.used).toBeLessThanOrEqual(1000);
    expect(r.packed[0]!.label).toBe('high');
    expect(r.packed.find((p) => p.label === 'mid')?.truncated).toBe(true);
    expect(r.dropped).toContain('low');
  });
});

describe('keywords & mentions', () => {
  it('extracts distinctive words from the Task B request', () => {
    const k = extractKeywords('Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking SECRET, PASSWORD, TOKEN or KEY');
    expect(k).toEqual(expect.arrayContaining(['config', 'command', 'cli']));
  });
  it('parses @file and @symbol mentions', () => {
    expect(parseMentions('fix @file:src/a.py and @symbol:get_debug_flag @file:src/a.py')).toEqual({ files: ['src/a.py'], symbols: ['get_debug_flag'] });
  });
  it('finds top-level python/ts symbols only', () => {
    expect(topLevelSymbols('def a():\n    def inner(): pass\nclass B:\n  x=1\nasync def c(): ...', 'x.py').map((s) => s.name)).toEqual(['a', 'B', 'c']);
    expect(topLevelSymbols('export async function foo() {}\nconst x = 1', 'x.ts').map((s) => s.name)).toEqual(['foo', 'x']);
  });
  it('merges nearby hit lines into windows', () => expect(windows([10, 12, 100], 200)).toEqual([[4, 18], [94, 106]]));
});

describe('assembleContext', () => {
  const cli = Array.from({ length: 300 }, (_, i) => (i === 100 ? 'def routes_command():' : `# line ${i + 1} config`)).join('\n');
  const files: Record<string, string> = { 'src/pkg/cli.py': cli, 'tests/test_cli.py': 'from pkg import cli\n\ndef test_x(): pass\n', 'docs/cli.rst': 'CLI\n===\n', 'src/pkg/other.py': 'x = 1\n' };
  const deps: ContextDeps = {
    listFiles: async () => Object.keys(files),
    searchKeyword: async (k) => Object.entries(files).flatMap(([p, t]) => t.split('\n').flatMap((l, i) => (l.toLowerCase().includes(k) ? [{ path: p, line: i + 1, text: l }] : []))).slice(0, 20),
    searchImporters: async (m) => Object.entries(files).filter(([, t]) => new RegExp(`from \\w+ import ${m}`).test(t)).map(([p]) => ({ path: p, line: 1, text: '' })),
    readText: async (p) => files[p],
    findSymbol: async () => undefined,
  };
  it('packs a shortlist under the budget with reasons, never whole big files', async () => {
    const r = await assembleContext('add a config command to the cli and test it', deps, 1500);
    expect(r.tokens).toBeLessThanOrEqual(1500);
    expect(r.items.some((i) => i.label.startsWith('src/pkg/cli.py'))).toBe(true);
    expect(r.items.every((i) => i.reason.length > 0)).toBe(true);
    expect(r.text).not.toContain('# line 250 config'); // far from any hit window is not included
    expect(r.items.some((i) => i.reason.includes('imports cli'))).toBe(true);
  });
});


describe('full rendered context bounds',()=>{
  it('accounts for metadata and fences with thousands of repository files',async()=>{
    const huge=Array.from({length:10000},(_,i)=>'config_value_'+i+' = "'+ 'x'.repeat(200)+'"').join('\n');
    const deps:ContextDeps={listFiles:async()=>Array.from({length:5000},(_,i)=>'src/config'+i+'.py'),searchKeyword:async()=>Array.from({length:1000},(_,i)=>({path:'src/config0.py',line:i+1,text:'config'})),searchImporters:async()=>[],readText:async()=>huge,findSymbol:async()=>undefined};
    for(const budget of [50,500,1500]){
      const r=await assembleContext('config @file:src/config0.py',deps,budget);
      expect(estimateTokens(r.text)).toBeLessThanOrEqual(budget);expect(r.tokens).toBe(estimateTokens(r.text));
      expect(r.text).not.toContain('config_value_9999');expect(r.items.every(i=>i.reason.length>0)).toBe(true);
    }
  });
  it('caps dense hit windows rather than merging the entire file',()=>{
    const w=windows(Array.from({length:1000},(_,i)=>i+1),1000);
    expect(w).toHaveLength(2);expect(w.every(([a,b])=>b-a<40)).toBe(true);
  });
  it('slices explicit mentions smaller than the old whole-file threshold',async()=>{
    const body=Array.from({length:100},(_,i)=>'# line '+i).join('\n');
    const deps:ContextDeps={listFiles:async()=>['a.py'],searchKeyword:async()=>[],searchImporters:async()=>[],readText:async()=>body,findSymbol:async()=>undefined};
    const r=await assembleContext('@file:a.py',deps,2000);expect(r.text).not.toContain('# line 99');
  });
});

describe('ripgrep combined scans & cancellation', () => {
  const cli = Array.from({ length: 300 }, (_, i) => (i === 100 ? 'def routes_command():' : `# line ${i + 1} config`)).join('\n');
  const files: Record<string, string> = { 'src/pkg/cli.py': cli, 'tests/test_cli.py': 'from pkg import cli\n\ndef test_x(): pass\n', 'docs/cli.rst': 'CLI\n===\n', 'src/pkg/other.py': 'x = 1\n' };
  const deps: ContextDeps = {
    listFiles: async () => Object.keys(files),
    searchKeyword: async (k) => Object.entries(files).flatMap(([p, t]) => t.split('\n').flatMap((l, i) => (l.toLowerCase().includes(k) ? [{ path: p, line: i + 1, text: l }] : []))).slice(0, 20),
    searchImporters: async (m) => Object.entries(files).filter(([, t]) => new RegExp(`from \\w+ import ${m}`).test(t)).map(([p]) => ({ path: p, line: 1, text: '' })),
    readText: async (p) => files[p],
    findSymbol: async () => undefined,
  };

  it('cancels runRg immediately if signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(runRg('rg-nonexistent', process.cwd(), ['.'], 15000, ac.signal)).rejects.toThrow('Operation aborted');
  });

  it('kills ripgrep child process when aborted mid-flight', async () => {
    const ac = new AbortController();
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => {
      setImmediate(() => child.emit('close', null));
      return true;
    });
    vi.mocked(spawn).mockReturnValueOnce(child as never);
    const p = runRg('rg-test', process.cwd(), ['.'], 15000, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toThrow('Operation aborted');
    expect(child.kill).toHaveBeenCalled();
  });

  it('assembleContext stops immediately on aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(assembleContext('config', deps, 1500, ac.signal)).rejects.toThrow('Operation aborted');
  });

  it('searchKeywords and searchAllImporters preserve ranking inputs and reasons', async () => {
    const depsBatched: ContextDeps = {
      ...deps,
      searchKeywords: async (kws) => {
        const m = new Map();
        for (const k of kws) m.set(k, await deps.searchKeyword(k));
        return m;
      },
      searchAllImporters: async (mods) => {
        const m = new Map();
        for (const mod of mods) m.set(mod, await deps.searchImporters(mod));
        return m;
      },
    };
    const r1 = await assembleContext('add a config command to the cli and test it', deps, 1500);
    const r2 = await assembleContext('add a config command to the cli and test it', depsBatched, 1500);
    expect(r2.tokens).toBe(r1.tokens);
    expect(r2.items.map((i) => i.label)).toEqual(r1.items.map((i) => i.label));
    expect(r2.items.map((i) => i.reason)).toEqual(r1.items.map((i) => i.reason));
  });
});

describe('per-request readText and symbol caching', () => {
  it('reads and parses each file at most once per request, and re-reads fresh content on subsequent requests', async () => {
    let fileContent = 'def foo():\n  return 1\n';
    const readCounts = new Map<string, number>();
    const deps: ContextDeps = {
      listFiles: async () => ['src/app.py'],
      searchKeyword: async () => [{ path: 'src/app.py', line: 1, text: 'def foo():' }],
      searchImporters: async () => [],
      readText: async (p) => {
        readCounts.set(p, (readCounts.get(p) ?? 0) + 1);
        return fileContent;
      },
      findSymbol: async (name) => (name === 'foo' ? { name: 'foo', kind: 'function', path: 'src/app.py', line: 1 } : undefined),
    };

    // Request 1: mentions @file and @symbol and matches keywords
    const r1 = await assembleContext('check @file:src/app.py and @symbol:foo for foo', deps, 1500);
    expect(r1.text).toContain('def foo()');
    expect(readCounts.get('src/app.py')).toBe(1);

    // Modify file content
    fileContent = 'def bar():\n  return 2\n';

    // Request 2: new request must read fresh content
    const r2 = await assembleContext('check @file:src/app.py', deps, 1500);
    expect(r2.text).toContain('def bar()');
    expect(readCounts.get('src/app.py')).toBe(2);
  });
});
