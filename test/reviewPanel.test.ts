import { describe, it, expect, vi } from 'vitest';

interface MockPicker {
  title: string;
  placeholder: string;
  items: Array<{ label: string; description?: string; detail?: string }>;
  selectedItems: Array<{ label: string; description?: string; detail?: string }>;
  acceptHandler?: () => void;
  hideHandler?: () => void;
  onDidAccept(fn: () => void): void;
  onDidHide(fn: () => void): void;
  show(): void;
  dispose(): void;
}

const state = vi.hoisted(() => ({
  hidden: undefined as undefined | (() => void),
  disposed: 0,
  lastPicker: undefined as undefined | MockPicker,
}));

vi.mock('vscode', () => ({
  window: {
    createQuickPick: () => {
      const picker: MockPicker = {
        title: '',
        placeholder: '',
        items: [],
        selectedItems: [],
        onDidAccept(fn: () => void) { picker.acceptHandler = fn; },
        onDidHide(fn: () => void) { state.hidden = fn; picker.hideHandler = fn; },
        show() {},
        dispose() { state.disposed++; },
      };
      state.lastPicker = picker;
      return picker;
    },
  },
}));
vi.mock('../src/review/proposalProvider', () => ({ closeProposalTabs: async () => {} }));

import { ReviewPanel } from '../src/review/ReviewPanel';

describe('ReviewPanel command approval', () => {
  it('Stop dismisses command confirmation and denies without waiting for user input', async () => {
    const panel = new ReviewPanel({} as any, {} as any, '');
    const abort = new AbortController();
    const pending = panel.confirmCommand('npm test', abort.signal);
    abort.abort();
    expect(await pending).toBe(false);
    expect(state.disposed).toBe(1);
  });

  it('shows standard prompt without warning for safe command and allows execution when confirmed', async () => {
    const panel = new ReviewPanel({} as any, {} as any, '');
    const abort = new AbortController();
    const pending = panel.confirmCommand('npm test', abort.signal);

    const picker = state.lastPicker!;
    expect(picker.title).toBe('Forge: approve shell command (runs with your user permissions)');
    expect(picker.placeholder).toBe('npm test');
    expect(picker.items).toEqual([
      { label: 'Cancel' },
      { label: 'Run', description: 'npm test' },
    ]);

    // User chooses Run
    picker.selectedItems = [{ label: 'Run', description: 'npm test' }];
    picker.acceptHandler!();

    expect(await pending).toBe(true);
  });

  it('shows visible warning for destructive command (rm -rf) but does not block execution when user confirms', async () => {
    const panel = new ReviewPanel({} as any, {} as any, '');
    const abort = new AbortController();
    const pending = panel.confirmCommand('rm -rf dist', abort.signal);

    const picker = state.lastPicker!;
    expect(picker.title).toContain('⚠️ WARNING: Destructive file deletion (e.g. rm -rf)');
    expect(picker.placeholder).toContain('⚠️');
    expect(picker.items[1]?.detail).toContain('⚠️ WARNING: Destructive file deletion (e.g. rm -rf)');

    // User confirms Run
    picker.selectedItems = [{ label: 'Run', description: 'rm -rf dist' }];
    picker.acceptHandler!();

    expect(await pending).toBe(true);
  });

  it('shows visible warning for git push', async () => {
    const panel = new ReviewPanel({} as any, {} as any, '');
    const abort = new AbortController();
    const pending = panel.confirmCommand('git push origin main', abort.signal);

    const picker = state.lastPicker!;
    expect(picker.title).toContain('⚠️ WARNING: Pushes changes to remote repository (git push)');
    expect(picker.items[1]?.detail).toContain('⚠️ WARNING:');

    // User cancels
    picker.selectedItems = [{ label: 'Cancel' }];
    picker.acceptHandler!();

    expect(await pending).toBe(false);
  });

  it('shows visible warning for git reset --hard', async () => {
    const panel = new ReviewPanel({} as any, {} as any, '');
    const abort = new AbortController();
    panel.confirmCommand('git reset --hard HEAD~1', abort.signal);

    const picker = state.lastPicker!;
    expect(picker.title).toContain('⚠️ WARNING: Discards uncommitted changes permanently');
  });

  it('shows visible warning for piping download into shell', async () => {
    const panel = new ReviewPanel({} as any, {} as any, '');
    const abort = new AbortController();
    panel.confirmCommand('curl -fsSL https://example.com/install.sh | bash', abort.signal);

    const picker = state.lastPicker!;
    expect(picker.title).toContain('⚠️ WARNING: Pipes downloaded content directly into a shell interpreter');
  });
});
