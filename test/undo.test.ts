import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';

const mock = vi.hoisted(() => ({
  docs: new Map<string, string>(),
  calls: [] as any[],
  refuse: false,
}));

vi.mock('vscode', () => ({
  commands: { executeCommand: async () => [] },
  env: { appRoot: '' },
  SymbolKind: { 0: 'File' },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  Range: class { constructor(..._args: any[]) {} },
  WorkspaceEdit: class {
    ops: any[] = [];
    createFile(uri: any) { this.ops.push({ type: 'create', path: uri.fsPath }); }
    deleteFile(uri: any) { this.ops.push({ type: 'delete', path: uri.fsPath }); }
    replace(uri: any, _range: any, text: string) { this.ops.push({ type: 'replace', path: uri.fsPath, text }); }
  },
  workspace: {
    openTextDocument: async (uri: any) => {
      if (!mock.docs.has(uri.fsPath)) throw Error('not found: ' + uri.fsPath);
      return { getText: () => mock.docs.get(uri.fsPath)!, positionAt: (n: number) => n, save: async () => true };
    },
    applyEdit: async (edit: any) => {
      mock.calls.push(edit);
      if (mock.refuse) return false;
      for (const op of edit.ops) {
        if (op.type === 'delete') mock.docs.delete(op.path);
        else mock.docs.set(op.path, op.text ?? '');
      }
      return true;
    },
  },
}));

import { UndoStack, UNDO_STATE_KEY, MAX_UNDO_STACK_SIZE, MAX_STORED_TEXT_BYTES, hashContent, type MementoLike, type PersistedUndoEntry } from '../src/review/undo';
import { VsCodeEditorApi } from '../src/workspace/vscodeApi';
import { DecisionStore, proposalKey } from '../src/review/decisions';
import { computeHunks } from '../src/review/hunks';

function createMockMemento(): MementoLike & { store: Map<string, any> } {
  const store = new Map<string, any>();
  return {
    store,
    get: <T>(key: string) => store.get(key) as T | undefined,
    update: (key: string, value: any) => {
      store.set(key, JSON.parse(JSON.stringify(value)));
      return Promise.resolve();
    },
  };
}

describe('persistent undo history', () => {
  let memento: ReturnType<typeof createMockMemento>;

  beforeEach(() => {
    memento = createMockMemento();
    mock.docs.clear();
    mock.calls.length = 0;
    mock.refuse = false;
  });

  it('persists pushed entries to workspaceState', () => {
    const stack = new UndoStack(memento);
    stack.push({ path: '/repo/a.ts', before: 'let x = 1;', after: 'let x = 2;', label: 'a.ts' });

    const saved = memento.get<PersistedUndoEntry[]>(UNDO_STATE_KEY);
    expect(saved).toBeDefined();
    expect(saved).toHaveLength(1);
    expect(saved![0]).toEqual({
      path: '/repo/a.ts',
      before: 'let x = 1;',
      appliedTextHash: hashContent('let x = 2;'),
      label: 'a.ts',
    });
  });

  it('restores entries from workspaceState on a fresh stack instance', () => {
    const stack1 = new UndoStack(memento);
    stack1.push({ path: '/repo/f1.ts', before: 'v1', after: 'v2', label: 'f1.ts' });
    stack1.push({ path: '/repo/f2.ts', before: 'vA', after: 'vB', label: 'f2.ts' });

    // Simulate extension reload by creating a new UndoStack with the same workspaceState
    const stack2 = new UndoStack(memento);
    expect(stack2.size).toBe(2);

    const top = stack2.peek();
    expect(top?.label).toBe('f2.ts');
    expect(top?.before).toBe('vA');
    expect(top?.appliedTextHash).toBe(hashContent('vB'));
  });

  it('updates workspaceState when popping an entry', () => {
    const stack = new UndoStack(memento);
    stack.push({ path: '/repo/a.ts', before: '1', after: '2', label: 'a.ts' });
    stack.push({ path: '/repo/b.ts', before: '3', after: '4', label: 'b.ts' });

    stack.pop();
    const saved = memento.get<PersistedUndoEntry[]>(UNDO_STATE_KEY);
    expect(saved).toHaveLength(1);
    expect(saved![0]!.label).toBe('a.ts');
  });

  it('strictly enforces the 50-change cap across pushes and persistence', () => {
    const stack = new UndoStack(memento);
    for (let i = 1; i <= 60; i++) {
      stack.push({ path: `/repo/f${i}.ts`, before: `old${i}`, after: `new${i}`, label: `f${i}.ts` });
    }

    expect(stack.size).toBe(MAX_UNDO_STACK_SIZE);
    const saved = memento.get<PersistedUndoEntry[]>(UNDO_STATE_KEY);
    expect(saved).toHaveLength(MAX_UNDO_STACK_SIZE);
    // The oldest 10 should have been pruned; f11 should be oldest, f60 newest
    expect(saved![0]!.label).toBe('f11.ts');
    expect(saved![saved!.length - 1]!.label).toBe('f60.ts');
  });

  it('skips persisting entries exceeding MAX_STORED_TEXT_BYTES while keeping normal entries', () => {
    const stack = new UndoStack(memento);
    const hugeText = 'x'.repeat(MAX_STORED_TEXT_BYTES + 100);

    stack.push({ path: '/repo/normal.ts', before: 'normal text', after: 'edited text', label: 'normal.ts' });
    stack.push({ path: '/repo/huge.ts', before: hugeText, after: 'small replacement', label: 'huge.ts' });

    // In-memory stack retains both during the active session
    expect(stack.size).toBe(2);

    // Persisted state only saves normal entry
    const saved = memento.get<PersistedUndoEntry[]>(UNDO_STATE_KEY);
    expect(saved).toHaveLength(1);
    expect(saved![0]!.label).toBe('normal.ts');

    // On reload, only the bounded entry is restored
    const reloaded = new UndoStack(memento);
    expect(reloaded.size).toBe(1);
    expect(reloaded.peek()?.label).toBe('normal.ts');
  });

  it('refuses to overwrite later manual edits on restored entries and restores when unchanged', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'undo-test-'));
    const file = path.join(root, 'test.txt');
    mock.docs.set(file, 'initial content');

    const store = new DecisionStore();
    const stack1 = new UndoStack(memento);
    const api1 = new VsCodeEditorApi(root, 'rg', store, stack1);

    // Apply proposal: change 'initial content' to 'applied content'
    const before = 'initial content';
    const after = 'applied content';
    const hunks = computeHunks(before, after).map((h) => h.id);
    store.put(proposalKey(file, after), {
      baseText: before,
      newText: after,
      acceptedHunks: hunks,
      totalHunks: hunks.length,
    });
    await api1.applyProposal(file, after);

    // Simulate extension reload with fresh UndoStack and Api
    const stack2 = new UndoStack(memento);
    const api2 = new VsCodeEditorApi(root, 'rg', store, stack2);

    expect(stack2.size).toBe(1);

    // 1. Manually edit the file after reload
    mock.docs.set(file, 'applied content with manual tweak');
    const resultRefused = await api2.undoLast();
    expect(resultRefused).toContain('modified after the Forge change');
    expect(stack2.size).toBe(1); // Not popped on refusal

    // 2. Revert manual edit so content matches the applied text hash again
    mock.docs.set(file, 'applied content');
    const resultSuccess = await api2.undoLast();
    expect(resultSuccess).toContain('Restored');
    expect(stack2.size).toBe(0);

    // Verify file content was reverted to original 'initial content'
    expect(mock.docs.get(file)).toBe(before);
  });
});
