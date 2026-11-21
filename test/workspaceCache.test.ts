import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceCache } from '../src/workspace/cache';

describe('WorkspaceCache (ITEM 3)', () => {
  let tmpDir: string;
  let cache: WorkspaceCache;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));
    cache = new WorkspaceCache(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves cached text on hit when file modification time and size are unchanged', async () => {
    const file = path.join(tmpDir, 'example.txt');
    fs.writeFileSync(file, 'Hello, World!');

    let freshReads = 0;
    const readFresh = async (p: string) => {
      freshReads++;
      return fs.readFileSync(p, 'utf8');
    };

    // First read: cache miss
    const text1 = await cache.getOrReadText(file, readFresh);
    expect(text1).toBe('Hello, World!');
    expect(freshReads).toBe(1);
    expect(cache.hits).toBe(0);
    expect(cache.misses).toBe(1);

    // Second read: cache hit (mtime & size match)
    const text2 = await cache.getOrReadText(file, readFresh);
    expect(text2).toBe('Hello, World!');
    expect(freshReads).toBe(1); // readFresh was NOT called
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
  });

  it('detects a changed file and never serves stale content', async () => {
    const file = path.join(tmpDir, 'example.txt');
    fs.writeFileSync(file, 'v1: initial content');

    let freshReads = 0;
    const readFresh = async (p: string) => {
      freshReads++;
      return fs.readFileSync(p, 'utf8');
    };

    // Read initial version
    const text1 = await cache.getOrReadText(file, readFresh);
    expect(text1).toBe('v1: initial content');
    expect(freshReads).toBe(1);

    // Update file with new content (different size and mtime)
    // Ensure mtime advances by at least 10ms for filesystems with coarse timestamps
    const later = new Date(Date.now() + 1000);
    fs.writeFileSync(file, 'v2: updated and modified content');
    fs.utimesSync(file, later, later);

    // Read again: must detect change, never serve stale content
    const text2 = await cache.getOrReadText(file, readFresh);
    expect(text2).toBe('v2: updated and modified content');
    expect(freshReads).toBe(2);
    expect(cache.misses).toBe(2);

    // Subsequent read of updated file is a hit
    const text3 = await cache.getOrReadText(file, readFresh);
    expect(text3).toBe('v2: updated and modified content');
    expect(freshReads).toBe(2);
    expect(cache.hits).toBe(1);
  });

  it('handles a deleted file by evicting from cache and returning undefined', async () => {
    const file = path.join(tmpDir, 'deleted.txt');
    fs.writeFileSync(file, 'will be deleted');

    const readFresh = async (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined);

    // Initial read
    const text1 = await cache.getOrReadText(file, readFresh);
    expect(text1).toBe('will be deleted');
    expect(cache.has(file)).toBe(true);

    // Delete file
    fs.unlinkSync(file);

    // Read deleted file
    const text2 = await cache.getOrReadText(file, readFresh);
    expect(text2).toBeUndefined();
    expect(cache.has(file)).toBe(false);
  });

  it('caches and invalidates workspace file list across requests', async () => {
    let listCalls = 0;
    const fetchFiles = async () => {
      listCalls++;
      return ['src/a.ts', 'src/b.ts'];
    };

    // First call: fetches and caches
    const list1 = await cache.getOrListFiles(fetchFiles);
    expect(list1).toEqual(['src/a.ts', 'src/b.ts']);
    expect(listCalls).toBe(1);

    // Second call: served from cache
    const list2 = await cache.getOrListFiles(fetchFiles);
    expect(list2).toEqual(['src/a.ts', 'src/b.ts']);
    expect(listCalls).toBe(1);

    // Invalidation clears list
    cache.invalidateFilesList();
    const list3 = await cache.getOrListFiles(fetchFiles);
    expect(list3).toEqual(['src/a.ts', 'src/b.ts']);
    expect(listCalls).toBe(2);
  });

  it('allows manual path invalidation on file-change events', async () => {
    const file = path.join(tmpDir, 'event.txt');
    fs.writeFileSync(file, 'before event');

    let freshReads = 0;
    const readFresh = async (p: string) => {
      freshReads++;
      return fs.readFileSync(p, 'utf8');
    };

    await cache.getOrReadText(file, readFresh);
    expect(freshReads).toBe(1);

    // File change event triggers invalidation
    cache.invalidatePath(file);
    expect(cache.has(file)).toBe(false);

    await cache.getOrReadText(file, readFresh);
    expect(freshReads).toBe(2);
  });
});
