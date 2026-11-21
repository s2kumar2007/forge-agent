import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EditorApi } from '../workspace/types';
import { PathError, isSecretPath, resolveInsideReal, toRel } from '../workspace/paths';
import { rankSymbols, rankTextHits } from '../context/rank';
import { extractOutline } from '../context/symbols';
import { materializeWrite } from '../review/proposal';

const MAX_READ_BYTES = 1_000_000;
const MAX_READ_LINES = 80;
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (...texts: string[]): ToolResult => ({ content: texts.map((text) => ({ type: 'text' as const, text })) });
const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: msg }], isError: true });

/** Converts thrown errors into MCP tool errors the model can read and recover from. */
async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try { return await fn(); } catch (e) { return fail(e instanceof PathError ? `Refused: ${e.message}` : `Error: ${e instanceof Error ? e.message : String(e)}`); }
}

export interface ToolOptions {
  getExplorationBudget?: () => number;
}

let defaultExplorationBudget = 12;
let readOnlyCount = 0;
const seenCalls = new Set<string>();

function canonicalize(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(canonicalize);
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(val as Record<string, unknown>).sort()) {
    sorted[k] = canonicalize((val as Record<string, unknown>)[k]);
  }
  return sorted;
}

function checkDuplicateCall(tool: string, args: unknown): ToolResult | undefined {
  const key = `${tool}:${JSON.stringify(canonicalize(args))}`;
  if (seenCalls.has(key)) {
    return ok('Duplicate call: use the earlier result and continue.');
  }
  seenCalls.add(key);
  return undefined;
}

export function setExplorationBudget(n: number): void {
  defaultExplorationBudget = Math.max(1, n);
}

export function resetToolRunState(): void {
  readOnlyCount = 0;
  seenCalls.clear();
}

export const resetToolDeduplication = resetToolRunState;

/** Registers the five editor tools. All paths are validated inside the workspace. */
export function registerEditorTools(mcp: McpServer, api: EditorApi, options?: ToolOptions): void {
  const root = api.root();

  function checkExplorationBudget(): ToolResult | undefined {
    const limit = options?.getExplorationBudget ? options.getExplorationBudget() : defaultExplorationBudget;
    if (readOnlyCount >= limit) {
      return fail('Exploration budget reached. Call propose_write now for each target file.');
    }
    readOnlyCount++;
    return undefined;
  }

  mcp.registerTool('read_file', {
    description: 'Read a workspace file, optionally only lines start..end (1-based, inclusive; at most 80 lines, or set outline=true for definitions). Prefer reading short slices.',
    inputSchema: { path: z.string(), start: z.number().int().min(1).optional(), end: z.number().int().min(1).optional(), outline: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  }, ({ path, start, end, outline }) => guarded(async () => {
    const dup = checkDuplicateCall('read_file', { path, start, end, outline });
    if (dup) return dup;
    const budgetError = checkExplorationBudget();
    if (budgetError) return budgetError;
    if (isSecretPath(path)) return fail('blocked: secret-like file');
    const abs = await resolveInsideReal(root, path);
    const rel = toRel(root, abs);
    if (isSecretPath(rel)) return fail('blocked: secret-like file');
    const text = await api.readText(abs);
    if (text === undefined) return fail(`File not found: ${path}`);
    if (outline) {
      const symbols = extractOutline(text, rel).slice(0, 200);
      if (symbols.length === 0) return ok(`${rel} outline: no definitions found.`);
      return ok(`${rel} outline (${symbols.length} definition${symbols.length === 1 ? '' : 's'}):\n` + symbols.map((s) => `${s.kind} ${s.name} line ${s.line}`).join('\n'));
    }
    if (Buffer.byteLength(text) > MAX_READ_BYTES && start === undefined) return fail('File is larger than 1MB; request a line range with start/end.');
    const lines = text.split('\n');
    if (lines.length > MAX_READ_LINES && (start === undefined || end === undefined)) return fail(`File has ${lines.length} lines; request a start/end range of at most ${MAX_READ_LINES} lines.`);
    const s = start ?? 1;
    const requestedEnd = end ?? lines.length;
    if (requestedEnd < s) return fail('end must be greater than or equal to start.');
    if (requestedEnd - s + 1 > MAX_READ_LINES) return fail(`Read range is limited to ${MAX_READ_LINES} lines; requested ${requestedEnd - s + 1} lines. Request a smaller slice of at most 80 lines (e.g. start=560, end=639), use outline=true for definitions, or proceed directly to propose_write.`);
    const e = Math.min(requestedEnd, lines.length);

    return ok(`${rel} lines ${s}-${e} of ${lines.length}`, lines.slice(s - 1, e).join('\n'));
  }));

  mcp.registerTool('list_dir', {
    description: 'List entries of a workspace directory ("." for the root). Directories end with "/".',
    inputSchema: { path: z.string().default('.') },
    annotations: { readOnlyHint: true },
  }, ({ path }) => guarded(async () => {
    const dup = checkDuplicateCall('list_dir', { path });
    if (dup) return dup;
    const budgetError = checkExplorationBudget();
    if (budgetError) return budgetError;
    if (isSecretPath(path)) return ok('(empty)');
    const abs = await resolveInsideReal(root, path);
    if (isSecretPath(toRel(root, abs))) return ok('(empty)');
    const entries = (await api.listDir(abs))
      .filter((e) => !isSecretPath(e.name))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return ok(entries.slice(0, 500).map((e) => e.name + (e.type === 'dir' ? '/' : '')).join('\n') || '(empty)');
  }));

  mcp.registerTool('search_workspace', {
    description: 'Search the workspace. kind="text": literal text search via ripgrep; kind="symbol": workspace symbol search. Results are ranked and each has a one-line reason ("why").',
    inputSchema: { query: z.string().min(1), kind: z.enum(['text', 'symbol']), max_results: z.number().int().min(1).max(50).default(20) },
    annotations: { readOnlyHint: true },
  }, ({ query, kind, max_results }) => guarded(async () => {
    const dup = checkDuplicateCall('search_workspace', { query, kind, max_results });
    if (dup) return dup;
    const budgetError = checkExplorationBudget();
    if (budgetError) return budgetError;
    if (kind === 'symbol') {
      const rawHits = (await api.searchSymbols(query, 100)).filter((s) => !isSecretPath(s.path));
      const ranked = rankSymbols(rawHits, query, max_results);
      if (ranked.length === 0) return ok('No symbols found.');
      const fileTextCache = new Map<string, string[] | undefined>();
      const getLines = async (relPath: string): Promise<string[] | undefined> => {
        if (fileTextCache.has(relPath)) return fileTextCache.get(relPath);
        try {
          const abs = await resolveInsideReal(root, relPath);
          if (isSecretPath(toRel(root, abs))) {
            fileTextCache.set(relPath, undefined);
            return undefined;
          }
          const text = await api.readText(abs);
          const ls = text !== undefined ? text.split('\n').map((l) => l.replace(/\r$/, '')) : undefined;
          fileTextCache.set(relPath, ls);
          return ls;
        } catch {
          fileTextCache.set(relPath, undefined);
          return undefined;
        }
      };
      const formatted = await Promise.all(ranked.map(async (s) => {
        let hitText = `${s.path}:${s.line}  ${s.kind} ${s.name}  -- why: ${s.why}`;
        const lines = await getLines(s.path);
        if (lines && s.line >= 1 && s.line <= lines.length) {
          const startLine = s.line;
          const endLine = Math.min(lines.length, startLine + 6);
          const snippet = lines.slice(startLine - 1, endLine).map((l, idx) => `  ${startLine + idx}: ${l.slice(0, 240)}`).join('\n');
          if (snippet) hitText += `\n${snippet}`;
        }
        return hitText;
      }));
      return ok(formatted.join('\n'));
    }
    const rawHits = (await api.searchText(query, 500)).filter((h) => !isSecretPath(h.path));
    const ranked = rankTextHits(rawHits, query, max_results);
    return ok(ranked.map((h) => `${h.path}:${h.line}  ${h.text.trim()}  -- why: ${h.why}`).join('\n') || 'No matches.');
  }));

  mcp.registerTool('propose_write', {
    description: 'Propose a reviewed file change. For existing files prefer edits: [{old_text,new_text}]; each old_text must match exactly once. For new files use complete new_content. Provide exactly one form, plus path and rationale. Nothing is written before hunk review. Call once per file.',
    inputSchema: { path: z.string(), new_content: z.string().optional(), edits: z.array(z.object({old_text:z.string().min(1),new_text:z.string()})).min(1).max(20).optional(), rationale: z.string() },
  }, (args) => guarded(async () => {
    const dup = checkDuplicateCall('propose_write', args);
    if (dup) return dup;
    if (isSecretPath(args.path)) return fail('blocked: secret-like file');
    const abs = await resolveInsideReal(root, args.path);
    if (isSecretPath(toRel(root, abs))) return fail('blocked: secret-like file');
    const candidate = materializeWrite(await api.readText(abs), args);
    return ok(await api.applyProposal(abs, candidate));
  }));

  mcp.registerTool('run_command', {
    description: 'Run a shell command in the workspace root (e.g. tests). Requires user approval. Output is truncated to 8KB; 120s timeout.',
    inputSchema: { command: z.string().min(1) },
  }, ({ command }) => guarded(async () => {
    const dup = checkDuplicateCall('run_command', { command });
    if (dup) return dup;
    const r = await api.runCommand(command);
    return ok(`exit code: ${r.exitCode ?? 'none'}${r.timedOut ? ' (timed out)' : ''}\n${r.output}`);
  }));
}
