import * as fs from 'node:fs/promises';

export interface CachedFile {
  text: string;
  mtimeMs: number;
  size: number;
}

export interface FileStat {
  mtimeMs: number;
  size: number;
}

/**
 * Cross-request cache for workspace file lists and file contents,
 * validated by file modification time (mtimeMs) and byte size.
 */
export class WorkspaceCache {
  private fileTextCache = new Map<string, CachedFile>();
  private filesList: string[] | undefined;
  public hits = 0;
  public misses = 0;

  constructor(readonly rootDir?: string) {}

  /**
   * Returns cached workspace file list or fetches and caches it.
   */
  async getOrListFiles(fetcher: () => Promise<string[]>): Promise<string[]> {
    if (this.filesList !== undefined) {
      this.hits++;
      return this.filesList;
    }
    this.misses++;
    const list = await fetcher();
    this.filesList = list;
    return list;
  }

  invalidateFilesList(): void {
    this.filesList = undefined;
  }

  /**
   * Reads file text validated by modification time and size.
   * If the file has not changed on disk (mtimeMs & size match), returns cached text (HIT).
   * If the file changed or is not cached, calls readFresh(abs) and caches the result (MISS).
   * If the file was deleted or cannot be stated, clears the cache and returns undefined.
   */
  async getOrReadText(
    abs: string,
    readFresh: (abs: string) => Promise<string | undefined>,
    statFn?: (abs: string) => Promise<FileStat | undefined>,
  ): Promise<string | undefined> {
    const stat = statFn ? await statFn(abs) : await this.defaultStat(abs);
    if (!stat) {
      this.fileTextCache.delete(abs);
      return await readFresh(abs);
    }

    const cached = this.fileTextCache.get(abs);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      this.hits++;
      return cached.text;
    }

    this.misses++;
    const text = await readFresh(abs);
    if (text !== undefined) {
      this.fileTextCache.set(abs, {
        text,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    } else {
      this.fileTextCache.delete(abs);
    }
    return text;
  }

  invalidatePath(abs: string): void {
    this.fileTextCache.delete(abs);
  }

  clear(): void {
    this.fileTextCache.clear();
    this.filesList = undefined;
    this.hits = 0;
    this.misses = 0;
  }

  has(abs: string): boolean {
    return this.fileTextCache.has(abs);
  }

  get size(): number {
    return this.fileTextCache.size;
  }

  private async defaultStat(abs: string): Promise<FileStat | undefined> {
    try {
      const s = await fs.stat(abs);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return undefined;
    }
  }
}
