import { spawn } from 'node:child_process';
import type { SearchHit, SymbolHit } from './types';

const EXCLUDES = ['!**/.git/**', '!**/node_modules/**', '!**/.venv/**', '!**/venv/**', '!**/__pycache__/**'];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DEF_RE = /(?:def|class|function|interface|enum|type|struct|fn|func)\s+(\w+)/;

/** Runs rg and returns stdout. Exit code 1 (= no matches) is not an error. */
export function runRg(rgPath: string, cwd: string, args: string[], timeoutMs = 15000, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Operation aborted'));
    const globs = EXCLUDES.flatMap((g) => ['--glob', g]);
    // Explicit "." path: without it rg may try to read stdin when spawned without a TTY.
    const child = spawn(rgPath, [...globs, ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const onAbort = () => {
      child.kill();
      reject(new Error('Operation aborted'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); if (out.length > 4_000_000) child.kill(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal?.aborted) return;
      if (code === 0 || code === 1 || out) resolve(out);
      else reject(new Error(`ripgrep failed (${code}): ${err.trim()}`));
    });
  });
}

interface RgJsonLine {
  type: string;
  data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string }; submatches?: { match?: { text?: string } }[] };
}

function parseJson(out: string, perFileCap: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const perFile = new Map<string, number>();
  for (const raw of out.split('\n')) {
    if (!raw) continue;
    let o: RgJsonLine;
    try { o = JSON.parse(raw) as RgJsonLine; } catch { continue; }
    if (o.type !== 'match' || !o.data?.path?.text) continue;
    const p = o.data.path.text.replace(/^\.[\\/]/, '').replace(/\\/g, '/');
    const n = (perFile.get(p) ?? 0) + 1;
    perFile.set(p, n);
    if (n > perFileCap) continue;
    hits.push({ path: p, line: o.data.line_number ?? 0, text: (o.data.lines?.text ?? '').replace(/\r?\n$/, '').slice(0, 240) });
  }
  return hits;
}

/** Case-insensitive literal text search (query is NOT treated as a regex). */
export async function rgText(rgPath: string, cwd: string, query: string, perFileCap = 5, signal?: AbortSignal): Promise<SearchHit[]> {
  if (!query.trim()) return [];
  const out = await runRg(rgPath, cwd, ['--json', '-i', '-F', '--max-columns', '400', '-e', query, '.'], 15000, signal);
  return parseJson(out, perFileCap);
}

/**
 * Searches multiple literal keywords in a single ripgrep call with alternation.
 * Returns a map of keyword -> search hits.
 */
export async function rgKeywords(
  rgPath: string,
  cwd: string,
  keywords: string[],
  perFileCap = 5,
  signal?: AbortSignal
): Promise<Map<string, SearchHit[]>> {
  const result = new Map<string, SearchHit[]>();
  const validKeywords = keywords.map((k) => k.trim()).filter(Boolean);
  for (const k of validKeywords) result.set(k, []);
  if (validKeywords.length === 0) return result;

  const args = ['--json', '-i', '-F', '--max-columns', '400', ...validKeywords.flatMap((k) => ['-e', k]), '.'];
  const out = await runRg(rgPath, cwd, args, 15000, signal);

  const counts = new Map<string, Map<string, number>>();
  for (const k of validKeywords) counts.set(k, new Map<string, number>());
  const kLowerList = validKeywords.map((k) => ({ original: k, lower: k.toLowerCase() }));

  for (const raw of out.split('\n')) {
    if (!raw) continue;
    let o: RgJsonLine;
    try { o = JSON.parse(raw) as RgJsonLine; } catch { continue; }
    if (o.type !== 'match' || !o.data?.path?.text) continue;
    const p = o.data.path.text.replace(/^\.[\\/]/, '').replace(/\\/g, '/');
    const lineNum = o.data.line_number ?? 0;
    const rawText = (o.data.lines?.text ?? '').replace(/\r?\n$/, '').slice(0, 240);
    const textLower = rawText.toLowerCase();

    for (const { original, lower } of kLowerList) {
      if (textLower.includes(lower)) {
        const fileMap = counts.get(original)!;
        const cur = fileMap.get(p) ?? 0;
        if (cur < perFileCap) {
          fileMap.set(p, cur + 1);
          result.get(original)!.push({ path: p, line: lineNum, text: rawText });
        }
      }
    }
  }
  return result;
}

/** Regex search (used internally for import detection). */
export async function rgRegex(rgPath: string, cwd: string, pattern: string, perFileCap = 3, signal?: AbortSignal): Promise<SearchHit[]> {
  const out = await runRg(rgPath, cwd, ['--json', '-i', '--max-columns', '400', '-e', pattern, '.'], 15000, signal);
  return parseJson(out, perFileCap);
}

/**
 * Searches multiple module imports in a single ripgrep call with alternation.
 * Returns a map of moduleName -> search hits.
 */
export async function rgAllImporters(
  rgPath: string,
  cwd: string,
  modules: string[],
  perFileCap = 1,
  signal?: AbortSignal
): Promise<Map<string, SearchHit[]>> {
  const result = new Map<string, SearchHit[]>();
  const validMods = [...new Set(modules.map((m) => m.trim()).filter((m) => m.length >= 3 && m !== '__init__'))];
  for (const m of validMods) result.set(m, []);
  if (validMods.length === 0) return result;

  const modPattern = validMods.map(escapeRe).join('|');
  const pattern = `^\\s*(?:from\\s+[\\w.]*\\b(?:${modPattern})\\b|import\\s+.*\\b(?:${modPattern})\\b)|(?:require|from)\\s*\\(?['"][^'"]*\\b(?:${modPattern})\\b`;
  const out = await runRg(rgPath, cwd, ['--json', '-i', '--max-columns', '400', '-e', pattern, '.'], 15000, signal);

  const regexes = validMods.map((mod) => {
    const m = escapeRe(mod);
    return {
      mod,
      re: new RegExp(`^\\s*(?:from\\s+[\\w.]*\\b${m}\\b|import\\s+.*\\b${m}\\b)|(?:require|from)\\s*\\(?['"][^'"]*\\b${m}\\b`, 'i'),
    };
  });

  const counts = new Map<string, Map<string, number>>();
  for (const m of validMods) counts.set(m, new Map<string, number>());

  for (const raw of out.split('\n')) {
    if (!raw) continue;
    let o: RgJsonLine;
    try { o = JSON.parse(raw) as RgJsonLine; } catch { continue; }
    if (o.type !== 'match' || !o.data?.path?.text) continue;
    const p = o.data.path.text.replace(/^\.[\\/]/, '').replace(/\\/g, '/');
    const lineNum = o.data.line_number ?? 0;
    const rawText = (o.data.lines?.text ?? '').replace(/\r?\n$/, '').slice(0, 240);

    for (const { mod, re } of regexes) {
      if (re.test(rawText)) {
        const fileMap = counts.get(mod)!;
        const cur = fileMap.get(p) ?? 0;
        if (cur < perFileCap) {
          fileMap.set(p, cur + 1);
          result.get(mod)!.push({ path: p, line: lineNum, text: rawText });
        }
      }
    }
  }
  return result;
}

export async function rgFiles(rgPath: string, cwd: string, signal?: AbortSignal): Promise<string[]> {
  const out = await runRg(rgPath, cwd, ['--files', '.'], 15000, signal);
  return out.split('\n').filter(Boolean).map((p) => p.replace(/^\.[\\/]/, '').replace(/\\/g, '/')).sort();
}

/** Fallback symbol search (when no language server answers): definition-looking lines. */
export async function rgSymbols(rgPath: string, cwd: string, query: string, max: number, signal?: AbortSignal): Promise<SymbolHit[]> {
  const q = escapeRe(query.trim());
  if (!q) return [];
  const pattern = `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:def|class|function|interface|enum|type|struct|fn|func)\\s+\\w*${q}\\w*`;
  const hits = await rgRegex(rgPath, cwd, pattern, 10, signal);
  const symbols: SymbolHit[] = [];
  for (const h of hits) {
    const m = DEF_RE.exec(h.text);
    if (m?.[1]) symbols.push({ name: m[1], kind: h.text.trim().split(/\s+/).find((w) => /^(def|class|function|interface|enum|type|struct|fn|func)$/.test(w)) ?? 'symbol', path: h.path, line: h.line });
    if (symbols.length >= max) break;
  }
  return symbols;
}
