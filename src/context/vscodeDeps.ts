import * as vscode from 'vscode';
import type { ContextDeps } from './assemble';
import type { VsCodeEditorApi } from '../workspace/vscodeApi';
import { rgAllImporters, rgFiles, rgKeywords, rgRegex, rgText } from './ripgrep';
import { isSecretPath, resolveInsideReal } from '../workspace/paths';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Real workspace access for the context assembler. The file list (repo map input) is cached and invalidated by a watcher. */
export class WorkspaceContextDeps implements ContextDeps {
  constructor(private api: VsCodeEditorApi, private rgPath: string, private root: string) {
    const cache = this.api.cache;
    const w = vscode.workspace.createFileSystemWatcher?.('**/*');
    if (w) {
      const reset = () => { cache.invalidateFilesList(); };
      w.onDidCreate?.((uri) => { reset(); cache.invalidatePath(uri.fsPath); });
      w.onDidDelete?.((uri) => { reset(); cache.invalidatePath(uri.fsPath); });
      w.onDidChange?.((uri) => { cache.invalidatePath(uri.fsPath); });
    }
    vscode.workspace.onDidChangeTextDocument?.((e) => {
      cache.invalidatePath(e.document.uri.fsPath);
    });
  }

  async listFiles(): Promise<string[]> {
    return this.api.cache.getOrListFiles(async () => {
      return (await rgFiles(this.rgPath, this.root)).filter((f) => !isSecretPath(f));
    });
  }
  async searchKeyword(k: string) {
    return (await rgText(this.rgPath, this.root, k, 5)).filter((h) => !isSecretPath(h.path));
  }
  async searchKeywords(keywords: string[], signal?: AbortSignal) {
    const raw = await rgKeywords(this.rgPath, this.root, keywords, 5, signal);
    const filtered = new Map<string, typeof raw extends Map<any, infer V> ? V : never>();
    for (const [k, hits] of raw.entries()) {
      filtered.set(k, hits.filter((h) => !isSecretPath(h.path)));
    }
    return filtered;
  }
  async searchImporters(mod: string) {
    const m = escapeRe(mod);
    return (await rgRegex(this.rgPath, this.root, `^\\s*(from\\s+[\\w.]*\\b${m}\\b|import\\s+.*\\b${m}\\b)|(require|from)\\s*\\(?['"][^'"]*\\b${m}\\b`, 1)).filter((h) => !isSecretPath(h.path));
  }
  async searchAllImporters(modules: string[], signal?: AbortSignal) {
    const raw = await rgAllImporters(this.rgPath, this.root, modules, 1, signal);
    const filtered = new Map<string, typeof raw extends Map<any, infer V> ? V : never>();
    for (const [mod, hits] of raw.entries()) {
      filtered.set(mod, hits.filter((h) => !isSecretPath(h.path)));
    }
    return filtered;
  }
  async readText(rel: string) {
    if (isSecretPath(rel)) return undefined;
    try { return await this.api.readText(await resolveInsideReal(this.root, rel)); } catch { return undefined; }
  }
  async findSymbol(name: string) {
    const hits = (await this.api.searchSymbols(name, 10)).filter((h) => !isSecretPath(h.path));
    return hits.find((h) => h.name === name) ?? hits[0];
  }

  /** Autocomplete for the input box: `file:` prefix -> paths, `symbol:` prefix -> symbols. */
  async suggest(prefix: string): Promise<{ insert: string; label: string }[]> {
    if (prefix.startsWith('symbol:')) {
      const q = prefix.slice(7);
      return (await this.api.searchSymbols(q || 'a', 8)).filter((s) => !isSecretPath(s.path)).map((s) => ({ insert: `@symbol:${s.name}`, label: `${s.name}  ${s.path}:${s.line}` }));
    }
    const q = prefix.replace(/^file:/, '').toLowerCase();
    return (await this.listFiles()).filter((f) => !isSecretPath(f) && f.toLowerCase().includes(q)).slice(0, 8).map((f) => ({ insert: `@file:${f}`, label: f }));
  }
}
