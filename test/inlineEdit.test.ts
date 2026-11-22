import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildInlinePrompt, inlineEdit } from '../src/inline/inlineEdit';

const mockVscode = vi.hoisted(() => ({
  warnings: [] as string[],
  errors: [] as string[],
  infos: [] as string[],
  progressReports: [] as any[],
  outputLines: [] as string[],
  inputBoxResult: 'fix the bug' as string | undefined,
  activeEditor: {
    selection: { isEmpty: false, start: { line: 10 }, end: { line: 15 } },
    document: {
      uri: { fsPath: '/test/workspace/src/app.py' },
      getText: () => 'def foo():\n    return False',
    },
  } as any,
  workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
}));

vi.mock('vscode', () => ({
  window: {
    get activeTextEditor() {
      return mockVscode.activeEditor;
    },
    showInputBox: async () => mockVscode.inputBoxResult,
    showWarningMessage: async (msg: string) => {
      mockVscode.warnings.push(msg);
    },
    showErrorMessage: async (msg: string) => {
      mockVscode.errors.push(msg);
    },
    showInformationMessage: async (msg: string) => {
      mockVscode.infos.push(msg);
    },
    withProgress: async (_opts: any, task: any) => {
      const progress = {
        report: (p: any) => mockVscode.progressReports.push(p),
      };
      const token = {
        onCancellationRequested: () => {},
      };
      return task(progress, token);
    },
    createOutputChannel: () => ({
      appendLine: (l: string) => mockVscode.outputLines.push(l),
      clear: () => {},
      dispose: () => {},
    }),
  },
  workspace: {
    get workspaceFolders() {
      return mockVscode.workspaceFolders;
    },
  },
  ProgressLocation: {
    Notification: 15,
  },
}));

describe('inlineEdit (STEP 2)', () => {
  beforeEach(() => {
    mockVscode.warnings = [];
    mockVscode.errors = [];
    mockVscode.infos = [];
    mockVscode.progressReports = [];
    mockVscode.outputLines = [];
    mockVscode.inputBoxResult = 'fix the bug';
    mockVscode.activeEditor = {
      selection: { isEmpty: false, start: { line: 10 }, end: { line: 15 } },
      document: {
        uri: { fsPath: '/test/workspace/src/app.py' },
        getText: () => 'def foo():\n    return False',
      },
    };
  });

  it('buildInlinePrompt formats prompt correctly', () => {
    const prompt = buildInlinePrompt('src/app.py', 11, 16, 'return False', 'treat off as false');
    expect(prompt).toContain('File: src/app.py');
    expect(prompt).toContain('lines 11-16');
    expect(prompt).toContain('treat off as false');
    expect(prompt).toContain('return False');
  });

  it('does NOT call showWarningMessage for notices during run; reports to progress', async () => {
    let capturedUi: any;
    const fakeController = {
      busy: false,
      cancel: vi.fn(),
      run: vi.fn(async (_p: string, ui: any) => {
        capturedUi = ui;
        ui.notice('Attempt 1 failed');
        ui.notice('Primary model failed, using fallback: google-gemini/gemini-3-8-flash (primary stalled)');
        ui.finished({ status: 'done' });
      }),
    } as any;

    await inlineEdit(fakeController, 'forge-inline');

    // No warning toasts stacked!
    expect(mockVscode.warnings).toEqual([]);

    // Notices reported to progress notification
    expect(mockVscode.progressReports.some((p) => p.message?.includes('Attempt 1 failed'))).toBe(true);

    // Output channel logged notices
    expect(mockVscode.outputLines).toContain('[notice] Attempt 1 failed');

    // Exactly ONE short info line shown on success after failover
    expect(mockVscode.infos).toEqual([
      'Forge: used the fallback model (primary stalled)',
    ]);
  });

  it('shows error popup on failure and nothing extra on clean success without failover', async () => {
    const successController = {
      busy: false,
      run: vi.fn(async (_p: string, ui: any) => {
        ui.finished({ status: 'done' });
      }),
    } as any;

    await inlineEdit(successController, 'forge-inline');
    expect(mockVscode.warnings).toEqual([]);
    expect(mockVscode.errors).toEqual([]);
    expect(mockVscode.infos).toEqual([]);

    const errorController = {
      busy: false,
      run: vi.fn(async (_p: string, ui: any) => {
        ui.finished({ status: 'error', message: 'Model refused to edit file' });
      }),
    } as any;

    await inlineEdit(errorController, 'forge-inline');
    expect(mockVscode.errors).toEqual(['Forge: Model refused to edit file']);
  });
});
