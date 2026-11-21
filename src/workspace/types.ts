export interface SearchHit { path: string; line: number; text: string }
export interface SymbolHit { name: string; kind: string; path: string; line: number }
export interface RunResult { exitCode: number | null; output: string; timedOut: boolean }
export interface DirEntry { name: string; type: 'file' | 'dir' }
export interface DiagnosticItem {
  path: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
}

/**
 * Everything the MCP tools need from the editor. Paths are ABSOLUTE and already
 * validated inside the workspace by the tool layer. Keeping this an interface lets
 * the logic be unit-tested without VS Code.
 */
export interface EditorApi {
  root(): string;
  /** Text of the file, preferring unsaved editor content; undefined if it does not exist. */
  readText(abs: string): Promise<string | undefined>;
  listDir(abs: string): Promise<DirEntry[]>;
  searchText(query: string, maxResults: number): Promise<SearchHit[]>;
  searchSymbols(query: string, maxResults: number): Promise<SymbolHit[]>;
  findReferences?(abs: string, line?: number, symbol?: string, maxResults?: number): Promise<SearchHit[]>;
  getDiagnostics?(abs?: string, severity?: 'error' | 'warning' | 'all'): Promise<DiagnosticItem[]>;
  runCommand(command: string): Promise<RunResult>;
  /** Applies a REVIEWED proposal. Must refuse when no review decision exists. */
  applyProposal(abs: string, newContent: string): Promise<string>;
}
