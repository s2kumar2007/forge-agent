import { createHash } from 'node:crypto';

export interface UndoEntry {
  path: string;
  before: string;
  after?: string;
  appliedTextHash?: string;
  label: string;
  created?: boolean;
}

export interface PersistedUndoEntry {
  path: string;
  before: string;
  appliedTextHash: string;
  label: string;
  created?: boolean;
}

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: any): Thenable<void> | Promise<void>;
}

export const UNDO_STATE_KEY = 'forge.undoStack';
export const MAX_UNDO_STACK_SIZE = 50;
export const MAX_STORED_TEXT_BYTES = 256 * 1024; // 256 KiB per entry
export const MAX_TOTAL_STORED_BYTES = 1024 * 1024; // 1 MiB across all persisted entries

export function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Undo stack persisted in context.workspaceState across extension reloads. */
export class UndoStack {
  private stack: UndoEntry[] = [];

  constructor(private memento?: MementoLike) {
    if (this.memento) {
      this.restore();
    }
  }

  push(e: UndoEntry): void {
    const entry: UndoEntry = {
      ...e,
      appliedTextHash: e.appliedTextHash ?? (e.after !== undefined ? hashContent(e.after) : ''),
    };
    this.stack.push(entry);
    if (this.stack.length > MAX_UNDO_STACK_SIZE) this.stack.shift();
    this.persist();
  }

  pop(): UndoEntry | undefined {
    const item = this.stack.pop();
    this.persist();
    return item;
  }

  peek(): UndoEntry | undefined {
    return this.stack[this.stack.length - 1];
  }

  get size(): number {
    return this.stack.length;
  }

  private persist(): void {
    if (!this.memento) return;
    const toSave: PersistedUndoEntry[] = [];
    let totalBytes = 0;
    // Iterate newest to oldest to preserve the most recent changes within budget
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const entry = this.stack[i];
      if (!entry) continue;
      const entryBytes = Buffer.byteLength(entry.before, 'utf8');
      if (entryBytes > MAX_STORED_TEXT_BYTES) {
        continue;
      }
      if (totalBytes + entryBytes > MAX_TOTAL_STORED_BYTES) {
        break;
      }
      totalBytes += entryBytes;
      toSave.unshift({
        path: entry.path,
        before: entry.before,
        appliedTextHash: entry.appliedTextHash ?? (entry.after !== undefined ? hashContent(entry.after) : ''),
        label: entry.label,
        created: entry.created,
      });
      if (toSave.length >= MAX_UNDO_STACK_SIZE) break;
    }
    void this.memento.update(UNDO_STATE_KEY, toSave);
  }

  restore(): void {
    if (!this.memento) return;
    const saved = this.memento.get<PersistedUndoEntry[]>(UNDO_STATE_KEY);
    if (!Array.isArray(saved)) return;
    this.stack = [];
    for (const item of saved) {
      if (
        item &&
        typeof item.path === 'string' &&
        typeof item.before === 'string' &&
        typeof item.appliedTextHash === 'string' &&
        typeof item.label === 'string' &&
        Buffer.byteLength(item.before, 'utf8') <= MAX_STORED_TEXT_BYTES
      ) {
        this.stack.push({
          path: item.path,
          before: item.before,
          appliedTextHash: item.appliedTextHash,
          label: item.label,
          created: Boolean(item.created),
        });
      }
    }
    if (this.stack.length > MAX_UNDO_STACK_SIZE) {
      this.stack = this.stack.slice(-MAX_UNDO_STACK_SIZE);
    }
  }
}
