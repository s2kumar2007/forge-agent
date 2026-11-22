import { estimateTokens, packContext, renderContextItem, type ContextItem, type PackedItem } from './budget';
import { extractKeywords, parseMentions } from './keywords';
import { topLevelSymbols } from './symbols';
import type { SearchHit, SymbolHit } from '../workspace/types';
import { isSecretPath } from '../workspace/paths';

/** Everything assemble() needs from the workspace; implemented with ripgrep/VS Code, faked in tests. */
export interface ContextDeps {
  listFiles(): Promise<string[]>;
  searchKeyword(keyword: string): Promise<SearchHit[]>;
  searchKeywords?(keywords: string[], signal?: AbortSignal): Promise<Map<string, SearchHit[]>>;
  searchImporters(moduleName: string): Promise<SearchHit[]>;
  searchAllImporters?(moduleNames: string[], signal?: AbortSignal): Promise<Map<string, SearchHit[]>>;
  readText(relPath: string): Promise<string | undefined>;
  findSymbol(name: string): Promise<SymbolHit | undefined>;
}

export interface ContextResult {
  /** Text block to prepend to the user message. */
  text: string;
  items: PackedItem[];
  tokens: number;
  budget: number;
  keywords: string[];
}

const SOURCE_RE = /\.(py|[cm]?[jt]sx?|go|rs|java|rb|c|h|cpp|cs|md|rst|txt|toml|json|ya?ml)$/i;
const fence = (p: string) => (p.endsWith('.py') ? 'python' : /\.[jt]sx?$/.test(p) ? 'ts' : '');
const slice = (lines: string[], a: number, b: number) => lines.slice(a - 1, b).join('\n');

/**
 * Computes IDF-like keyword weight:
 * w(k) = clamp(ln((N+1)/(df+1)) / ln(N+1) * 2, 0.15, 1.5).
 */
export function keywordWeight(df: number, N: number): number {
  if (N <= 0) return 1.0;
  const num = Math.log((N + 1) / (df + 1));
  const den = Math.log(N + 1);
  if (den === 0) return 1.0;
  const raw = (num / den) * 2;
  return Math.max(0.15, Math.min(1.5, raw));
}

export const RARE_WEIGHT = 1.0;

/** Merges hit line numbers into <= maxSlices windows of +-pad lines without overlaps. */
export function windows(hitLines: number[], total: number, pad = 6, maxSlices = 2): [number, number][] {
  if (hitLines.length === 0 || total <= 0) return [];
  const sorted = [...new Set(hitLines)].filter((l) => l >= 1 && l <= total).sort((a, b) => a - b);
  if (sorted.length === 0) return [];

  const rawRanges: [number, number][] = sorted.map((l) => [Math.max(1, l - pad), Math.min(total, l + pad)]);
  rawRanges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged: [number, number][] = [];
  for (const [start, end] of rawRanges) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push([start, end]);
      continue;
    }
    if (start <= prev[1] + 1) {
      const newEnd = Math.max(prev[1], end);
      if (newEnd - prev[0] + 1 <= 40) {
        prev[1] = newEnd;
      } else {
        prev[1] = Math.min(total, prev[0] + 39);
        const nextStart = Math.max(prev[1] + 1, start);
        if (nextStart <= end) {
          merged.push([nextStart, Math.min(total, Math.min(end, nextStart + 39))]);
        }
      }
    } else {
      merged.push([start, Math.min(total, Math.min(end, start + 39))]);
    }
  }

  const result: [number, number][] = [];
  for (const [start, end] of merged) {
    const prev = result[result.length - 1];
    if (!prev) {
      result.push([start, end]);
    } else if (start <= prev[1]) {
      const adjStart = prev[1] + 1;
      if (adjStart <= end) {
        result.push([adjStart, end]);
      }
    } else {
      result.push([start, end]);
    }
  }

  return result.slice(0, maxSlices);
}

function isTestOrDocFile(p: string): { isTest: boolean; isDoc: boolean } {
  const l = p.toLowerCase();
  const isTest = /(?:^|\/)(?:tests?|testing|specs?)\//.test(l) || /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.[^/]+$/.test(l);
  const isDoc = /(?:^|\/)(?:docs?|documentation)\//.test(l) || /\.(?:rst|md|markdown)$/i.test(l);
  return { isTest, isDoc };
}

/**
 * Builds the automatic context for a request under a TOKEN BUDGET. Never sends whole files:
 *   1. explicit @file/@symbol mentions (highest priority, capped slices)
 *   2. ranked shortlist: keyword hits (ripgrep) + symbol-name matches + files importing matched modules
 *   3. a compact repo map (file tree) limited to ~20% of the budget
 * For each ranked file: its top-level signatures + the slices around the hits.
 */
export async function assembleContext(request: string, deps: ContextDeps, budget: number, signal?: AbortSignal): Promise<ContextResult> {
  if (signal?.aborted) throw new Error('Operation aborted');
  const fileTextCache = new Map<string, string | undefined>();
  const symCache = new Map<string, ReturnType<typeof topLevelSymbols>>();

  const cachedReadText = async (p: string): Promise<string | undefined> => {
    if (fileTextCache.has(p)) return fileTextCache.get(p);
    const text = await deps.readText(p);
    fileTextCache.set(p, text);
    return text;
  };

  const cachedTopLevelSymbols = (text: string, p: string) => {
    let syms = symCache.get(p);
    if (!syms) {
      syms = topLevelSymbols(text, p);
      symCache.set(p, syms);
    }
    return syms;
  };
  const keywords = extractKeywords(request);
  const mentions = parseMentions(request);
  const files = (await deps.listFiles()).filter((f) => !isSecretPath(f) && SOURCE_RE.test(f));
  if (signal?.aborted) throw new Error('Operation aborted');
  const items: ContextItem[] = [];

  // --- 1. explicit mentions ---
  for (const f of mentions.files) {
    if (isSecretPath(f)) continue;
    if (signal?.aborted) throw new Error('Operation aborted');
    const text = await cachedReadText(f);
    if (text === undefined) continue;
    const lines = text.split('\n');
    const sigs = cachedTopLevelSymbols(text, f).slice(0, 25).map((s) => `${s.line}: ${s.signature}`).join('\n');
    const body = `${slice(lines, 1, 40)}\n...\n[signatures]\n${sigs}`;
    items.push({ label: `${f}:1-${Math.min(40, lines.length)} + signatures`, reason: 'mentioned with @file', text: body, priority: 100 });
  }
  for (const name of mentions.symbols) {
    if (signal?.aborted) throw new Error('Operation aborted');
    const hit = await deps.findSymbol(name);
    if (!hit || isSecretPath(hit.path)) continue;
    const text = await cachedReadText(hit.path);
    if (text === undefined) continue;
    const lines = text.split('\n');
    const a = Math.max(1, hit.line - 2), b = Math.min(lines.length, hit.line + 40);
    items.push({ label: `${hit.path}:${a}-${b}`, reason: `mentioned with @symbol ${name}`, text: slice(lines, a, b), priority: 99 });
  }

  // --- 2. ranked shortlist ---
  const score = new Map<string, number>();
  const why = new Map<string, string[]>();
  const hitLines = new Map<string, number[]>();
  const strongReasons = new Set<string>();

  // `front` puts structural reasons (imports) ahead of keyword-hit reasons.
  const bump = (f: string, n: number, reason: string, front = false, isStrong = false) => {
    score.set(f, (score.get(f) ?? 0) + n);
    why.set(f, front ? [reason, ...(why.get(f) ?? [])] : [...(why.get(f) ?? []), reason]);
    if (isStrong) {
      strongReasons.add(f);
    }
  };

  let perKeyword: [string, SearchHit[]][];
  if (deps.searchKeywords) {
    const kwMap = await deps.searchKeywords(keywords, signal);
    perKeyword = keywords.map((k) => [k, kwMap.get(k) ?? []] as const);
  } else {
    perKeyword = await Promise.all(keywords.map(async (k) => [k, await deps.searchKeyword(k)] as const));
  }
  if (signal?.aborted) throw new Error('Operation aborted');

  // Compute corpus document frequency and IDF-like weights
  const N = Math.max(1, files.length);
  const kwWeights = new Map<string, number>();
  for (const [k, hits] of perKeyword) {
    const matchingFiles = new Set(hits.filter((h) => !isSecretPath(h.path)).map((h) => h.path));
    const df = matchingFiles.size;
    const w = keywordWeight(df, N);
    kwWeights.set(k, w);
  }

  for (const [k, hits] of perKeyword) {
    const w = kwWeights.get(k) ?? 1.0;
    const isRare = w >= RARE_WEIGHT;
    const byFile = new Map<string, SearchHit[]>();
    for (const h of hits) {
      if (isSecretPath(h.path)) continue;
      byFile.set(h.path, [...(byFile.get(h.path) ?? []), h]);
    }
    for (const [f, hs] of byFile) {
      const points = Math.min(hs.length, 5) * w;
      const label = isRare ? `${hs.length} hit(s) for rare term "${k}"` : `${hs.length} hit(s) for "${k}"`;
      bump(f, points, label, false, isRare);
      hitLines.set(f, [...(hitLines.get(f) ?? []), ...hs.map((h) => h.line)]);
    }
  }

  for (const f of files) {
    const base = f.toLowerCase();
    const segments = base.split('/');
    const filename = segments[segments.length - 1] ?? '';
    const stem = filename.replace(/\.[^.]+$/, '');

    for (const k of keywords) {
      const w = kwWeights.get(k) ?? 1.0;
      const isRare = w >= RARE_WEIGHT;

      const isExactMatch =
        stem === k ||
        stem === `test_${k}` ||
        stem === `${k}_test` ||
        segments.includes(k);

      if (isExactMatch) {
        if (isRare) {
          bump(f, 10, `path matches rare keyword "${k}"`, false, true);
        } else {
          bump(f, 3, `path matches keyword "${k}"`, false, false);
        }
      } else if (segments.some((s) => s.includes(k))) {
        if (isRare) {
          bump(f, 3, `path contains rare keyword "${k}"`, false, true);
        } else {
          bump(f, 1, `path contains "${k}"`, false, false);
        }
      }
    }

    if (/(?:^|\/)(?:changes|changelog|history|news)\./i.test(base)) {
      score.set(f, (score.get(f) ?? 0) - 20);
    }
  }

  // Symbol-name matches among top candidates
  const top = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([f]) => f);
  for (const f of top) {
    if (signal?.aborted) throw new Error('Operation aborted');
    const text = await cachedReadText(f);
    if (text === undefined) continue;
    const syms = cachedTopLevelSymbols(text, f);
    for (const k of keywords) {
      const w = kwWeights.get(k) ?? 1.0;
      const isRare = w >= RARE_WEIGHT;
      const m = syms.find((s) => s.name.toLowerCase().includes(k));
      if (m) {
        bump(f, 4 * w, `defines "${m.name}"`, false, isRare);
        hitLines.set(f, [...(hitLines.get(f) ?? []), m.line]);
      }
    }
  }

  // Identify primary implementation targets (highest score non-test non-doc files, score >= 0.6 * best, max 2)
  const nonTestNonDocs = [...score.entries()]
    .filter(([f]) => {
      const { isTest, isDoc } = isTestOrDocFile(f);
      return !isTest && !isDoc;
    })
    .sort((a, b) => b[1] - a[1]);

  const bestNonTestScore = nonTestNonDocs[0]?.[1] ?? 0;
  const primaryTargets: string[] = [];
  if (bestNonTestScore > 0) {
    for (const [f, sc] of nonTestNonDocs) {
      if (sc >= 0.6 * bestNonTestScore && primaryTargets.length < 2) {
        primaryTargets.push(f);
      }
    }
  }

  const linkedTests = new Set<string>();
  const linkedDocs = new Set<string>();

  for (const pTarget of primaryTargets) {
    const stem = pTarget.replace(/\.[^.]+$/, '').split('/').pop()!;
    if (stem.length < 3 || stem === '__init__') continue;

    const testRegex = new RegExp(`(?:^|/)(?:test_${stem}|${stem}_test|test_${stem}\\.[^.]+)$`, 'i');
    const docRegex = new RegExp(`(?:^|/)docs/.*${stem}.*`, 'i');

    for (const file of files) {
      if (file === pTarget) continue;
      const { isTest, isDoc } = isTestOrDocFile(file);

      if (isTest && (testRegex.test(file) || file.toLowerCase().includes(`test_${stem}`))) {
        linkedTests.add(file);
        bump(file, 25, `test for primary target ${pTarget}`, true, true);
        if (!hitLines.has(file) || hitLines.get(file)!.length === 0) {
          const testText = await cachedReadText(file);
          if (testText) {
            const lines = testText.split('\n');
            const matchLine = lines.findIndex((l) => l.toLowerCase().includes(stem.toLowerCase()));
            const startLine = matchLine >= 0 ? Math.max(1, matchLine - 2) : 1;
            hitLines.set(file, [startLine]);
          }
        }
      } else if (isDoc && (docRegex.test(file) || file.toLowerCase().includes(`/${stem}.`) || file.toLowerCase().includes(`_${stem}.`))) {
        linkedDocs.add(file);
        bump(file, 25, `docs for primary target ${pTarget}`, true, true);
        if (!hitLines.has(file) || hitLines.get(file)!.length === 0) {
          const docText = await cachedReadText(file);
          if (docText) {
            const lines = docText.split('\n');
            const matchLine = lines.findIndex((l) => l.toLowerCase().includes(stem.toLowerCase()));
            const startLine = matchLine >= 0 ? Math.max(1, matchLine - 2) : 1;
            hitLines.set(file, [startLine]);
          }
        }
      }
    }
  }

  // Files importing the best matches
  const candidateMods: { file: string; mod: string }[] = [];
  for (const f of [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([x]) => x)) {
    const mod = f.replace(/\.[^.]+$/, '').split('/').pop()!;
    if (mod.length < 3 || mod === '__init__') continue;
    candidateMods.push({ file: f, mod });
  }
  if (candidateMods.length > 0) {
    if (deps.searchAllImporters) {
      const impMap = await deps.searchAllImporters(candidateMods.map((c) => c.mod), signal);
      for (const { file: f, mod } of candidateMods) {
        for (const h of impMap.get(mod) ?? []) if (h.path !== f && !isSecretPath(h.path)) bump(h.path, 1.5, `imports ${mod}`, true);
      }
    } else {
      for (const { file: f, mod } of candidateMods) {
        for (const h of await deps.searchImporters(mod)) if (h.path !== f && !isSecretPath(h.path)) bump(h.path, 1.5, `imports ${mod}`, true);
      }
    }
  }
  if (signal?.aborted) throw new Error('Operation aborted');

  // Penalize files that have ONLY generic reasons and NO strong reason (-20)
  for (const [f, sc] of score.entries()) {
    if (!strongReasons.has(f)) {
      score.set(f, sc - 20);
    }
  }

  // Reservation for tests and docs if requested
  const wantsTestsOrDocs = /\btests?\b|\bdocument|\bdocs?\b/i.test(request);
  let bestTestFile: string | undefined;
  let bestDocFile: string | undefined;

  if (wantsTestsOrDocs) {
    let bestTestScore = -Infinity;
    for (const tFile of linkedTests) {
      const sc = score.get(tFile) ?? 0;
      if (sc > bestTestScore) {
        bestTestScore = sc;
        bestTestFile = tFile;
      }
    }
    let bestDocScore = -Infinity;
    for (const dFile of linkedDocs) {
      const sc = score.get(dFile) ?? 0;
      if (sc > bestDocScore) {
        bestDocScore = sc;
        bestDocFile = dFile;
      }
    }
  }

  const topScored = [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const candidateFiles = new Set(topScored.slice(0, 12).map(([f]) => f));
  if (bestTestFile) candidateFiles.add(bestTestFile);
  if (bestDocFile) candidateFiles.add(bestDocFile);

  for (const f of candidateFiles) {
    const sc = score.get(f) ?? 0;
    const text = await cachedReadText(f);
    if (text === undefined) continue;
    const lines = text.split('\n');
    const syms = cachedTopLevelSymbols(text, f);
    const reason = [...new Set(why.get(f))].slice(0, 5).join('; ');
    const sigs = syms.slice(0, 25).map((s) => `${s.line}: ${s.signature}`).join('\n');

    let priorityBoost = 0;
    if (f === bestTestFile || f === bestDocFile) {
      priorityBoost = 40;
    }

    if (sigs) items.push({ label: `${f} (signatures)`, reason, text: sigs, priority: 40 + sc + priorityBoost });
    for (const [a, b] of windows(hitLines.get(f) ?? [], lines.length)) {
      items.push({ label: `${f}:${a}-${b}`, reason, text: slice(lines, a, b), priority: 50 + sc + priorityBoost });
    }
  }

  // --- 3. repo map, capped at ~20% of the budget ---
  items.push({ label: 'repo map', reason: 'file tree overview', text: renderTree(files, Math.floor(budget * 0.2) * 4), priority: 30 });

  const limit = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;
  const prefix = '[Forge context: automatically selected under a ' + limit + '-token estimated budget. Treat snippets as hints; use search_workspace/read_file for more. State files and reasons.]\n\n';
  if (estimateTokens(prefix) >= limit) return { text: '', items: [], tokens: 0, budget: limit, keywords };
  const { packed } = packContext(items, limit - estimateTokens(prefix));
  const text = prefix + packed.map(renderContextItem).join('');
  return { text, items: packed, tokens: estimateTokens(text), budget: limit, keywords };
}

/** Directory -> files listing, truncated to maxChars. */
export function renderTree(files: string[], maxChars: number): string {
  const dirs = new Map<string, string[]>();
  for (const f of files) {
    const i = f.lastIndexOf('/');
    const d = i < 0 ? '.' : f.slice(0, i);
    dirs.set(d, [...(dirs.get(d) ?? []), f.slice(i + 1)]);
  }
  let out = '';
  for (const [d, fs] of [...dirs.entries()].sort()) {
    const line = `${d}/: ${fs.slice(0, 12).join(', ')}${fs.length > 12 ? `, +${fs.length - 12} more` : ''}\n`;
    if (out.length + line.length > maxChars) { out += '...(truncated)\n'; break; }
    out += line;
  }
  return out;
}

export function computeAdaptiveBudget(request: string, baseBudget = 3000): number {
  const isComplex = /(?:multi-file|tests?|docs?|cli|command|refactor|feature|implement|add|create)/i.test(request) ||
    (request.match(/@file:/g) ?? []).length > 1 ||
    request.length > 120;
  if (isComplex) {
    return Math.min(4000, baseBudget + 1000);
  }
  return Math.min(3000, baseBudget);
}

export { estimateTokens };
