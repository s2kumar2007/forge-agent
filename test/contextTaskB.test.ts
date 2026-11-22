import { describe, it, expect } from 'vitest';
import { assembleContext, keywordWeight, windows, type ContextDeps } from '../src/context/assemble';

describe('context Task B multi-file assembly (STEP 3)', () => {
  const files: Record<string, string> = {};

  // Primary implementation file containing rare keyword 'cli' and common words
  files['src/flask/cli.py'] = [
    '# Flask Command Line Interface',
    'import sys',
    'def main():',
    '    pass',
    '',
    'def cli():',
    '    """Root CLI group."""',
    '    pass',
    '',
    '# config option handler',
    'def load_config():',
    '    pass',
  ].join('\n');

  // Test file for cli
  files['tests/test_cli.py'] = [
    '# Tests for CLI',
    'import pytest',
    'from flask.cli import cli',
    '',
    'def test_cli_simple():',
    '    assert True',
  ].join('\n');

  // Doc file for cli
  files['docs/cli.rst'] = [
    'Command Line Interface',
    '======================',
    '',
    'The flask cli provides commands for running the application.',
    'Options include --config for configuration files.',
  ].join('\n');

  // Other flask modules (app, blueprints, etc.) containing common words
  files['src/flask/app.py'] = [
    '# Flask application object',
    'class Flask:',
    '    def __init__(self, config=None, option=None):',
    '        self.config = config',
    '        self.option = option',
  ].join('\n');

  files['src/flask/blueprints.py'] = [
    '# Flask blueprints',
    'class Blueprint:',
    '    def __init__(self, name, config=None, option=None):',
    '        self.config = config',
    '        self.option = option',
  ].join('\n');

  // 135 other files containing common words 'flask', 'config', 'option'
  for (let i = 0; i < 135; i++) {
    files[`src/flask/module_${i}.py`] = [
      `# flask module ${i}`,
      `# config setting for module ${i}`,
      `# option parameter for module ${i}`,
      `def func_${i}():`,
      `    return "flask config option ${i}"`,
    ].join('\n');
  }

  const deps: ContextDeps = {
    listFiles: async () => Object.keys(files),
    searchKeyword: async (k) => {
      const q = k.toLowerCase();
      const hits = [];
      for (const [p, text] of Object.entries(files)) {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.toLowerCase().includes(q)) {
            hits.push({ path: p, line: i + 1, text: lines[i]! });
          }
        }
      }
      return hits;
    },
    searchImporters: async (mod) => {
      const hits = [];
      for (const [p, text] of Object.entries(files)) {
        if (text.includes(`from flask.${mod}`) || text.includes(`import ${mod}`)) {
          hits.push({ path: p, line: 1, text: '' });
        }
      }
      return hits;
    },
    readText: async (p) => files[p],
    findSymbol: async () => undefined,
  };

  it('assembles context prioritizing primary target, tests, and docs under 2000 token budget', async () => {
    const request = 'add a --config option to the flask cli and document it; update tests';
    const result = await assembleContext(request, deps, 2000);

    // a) src/flask/cli.py is included with hit windows
    const cliWindows = result.items.filter((it) => it.label.startsWith('src/flask/cli.py:'));
    expect(cliWindows.length).toBeGreaterThan(0);
    expect(result.items.some((it) => it.label.startsWith('src/flask/cli.py'))).toBe(true);

    // b) No overlapping windows exist in any file
    const windowsByFile = new Map<string, [number, number][]>();
    for (const it of result.items) {
      const match = /^([^:]+):(\d+)-(\d+)$/.exec(it.label);
      if (match) {
        const file = match[1]!;
        const start = parseInt(match[2]!, 10);
        const end = parseInt(match[3]!, 10);
        const list = windowsByFile.get(file) ?? [];
        list.push([start, end]);
        windowsByFile.set(file, list);
      }
    }
    for (const [file, wList] of windowsByFile.entries()) {
      wList.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < wList.length; i++) {
        const prev = wList[i - 1]!;
        const curr = wList[i]!;
        expect(curr[0]).toBeGreaterThan(prev[1]); // Strict non-overlap
      }
    }

    // c) tests/test_cli.py is included (test reservation)
    expect(result.items.some((it) => it.label.startsWith('tests/test_cli.py'))).toBe(true);

    // d) docs/cli.rst is included (docs reservation)
    expect(result.items.some((it) => it.label.startsWith('docs/cli.rst'))).toBe(true);

    // e) Irrelevant files like app.py / blueprints.py don't crowd out test_cli / docs
    const testCliIdx = result.items.findIndex((it) => it.label.startsWith('tests/test_cli.py'));
    const docsCliIdx = result.items.findIndex((it) => it.label.startsWith('docs/cli.rst'));
    const appIdx = result.items.findIndex((it) => it.label.startsWith('src/flask/app.py'));
    expect(testCliIdx).toBeLessThan(appIdx);
    expect(docsCliIdx).toBeLessThan(appIdx);

    // f) Total tokens <= 2000
    expect(result.tokens).toBeLessThanOrEqual(2000);
  });

  it('merges overlapping and adjacent windows properly', () => {
    // Overlapping ranges like 11-49 and 39-67
    const merged = windows([20, 45, 60], 100, 15, 2);
    expect(merged.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < merged.length; i++) {
      expect(merged[i]![0]).toBeGreaterThan(merged[i - 1]![1]);
    }
  });

  it('computes keyword weights correctly', () => {
    const N = 140;
    const rareW = keywordWeight(3, N); // rare word in 3 files
    const commonW = keywordWeight(135, N); // common word in 135 files
    expect(rareW).toBeGreaterThanOrEqual(1.0);
    expect(commonW).toBeLessThan(0.4);
    expect(commonW).toBeGreaterThanOrEqual(0.15);
  });
});
