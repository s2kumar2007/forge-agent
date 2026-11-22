import { isSecretPath } from '../workspace/paths';

export interface CompletedToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

export interface PendingDiff {
  path: string;
  rationale?: string;
  edits?: Array<{
    old_text?: string;
    new_text?: string;
    search?: string;
    replace?: string;
    startLine?: number;
    endLine?: number;
    newText?: string;
  }>;
  new_content?: string;
  changes?: Array<Record<string, unknown>>;
}

export interface HandoffBriefOptions {
  maxTokens?: number;
}

const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_dir',
  'search_workspace',
  'search_symbols',
  'find_references',
  'get_diagnostics',
]);

/**
 * Tracks read-only exploration, model plans, and proposed diffs during a primary attempt,
 * then constructs a compact handoff brief for the fallback agent so it continues without
 * repeating exploration.
 */
export class HandoffTracker {
  private originalRequest = '';
  private assembledContext = '';
  private completedReadOnlyCalls: CompletedToolCall[] = [];
  private uniqueFilesRead = new Set<string>();
  private planText = '';
  private pendingDiffs: PendingDiff[] = [];

  constructor(initialRequest?: string) {
    if (initialRequest) {
      this.recordRequest(initialRequest);
    }
  }

  recordRequest(request: string): void {
    const taskMatch = /^## Task\s*\n([\s\S]*?)(?=\n## Context|$)/i.exec(request);
    const ctxMatch = /## Context[^\n]*\n([\s\S]*?)(?=\n## Reminder|$)/i.exec(request);
    if (taskMatch) {
      this.originalRequest = taskMatch[1]!.trim();
      if (ctxMatch) {
        this.assembledContext = ctxMatch[1]!.trim();
      }
    } else {
      this.originalRequest = request.trim();
    }
  }

  recordAssembledContext(context: string): void {
    if (context && !isSecretPath(context)) {
      this.assembledContext = context.trim();
    }
  }

  recordReadOnlyCall(name: string, args: Record<string, unknown>, resultText: string): void {
    if (!READ_ONLY_TOOLS.has(name)) return;

    const pathArg = typeof args.path === 'string' ? args.path : undefined;
    if (pathArg && isSecretPath(pathArg)) {
      return; // Never record secret files
    }

    if (name === 'read_file' && pathArg) {
      this.uniqueFilesRead.add(pathArg);
    }

    const trimmedResult = (resultText || '').trim().slice(0, 1500);
    this.completedReadOnlyCalls.push({
      name,
      args: { ...args },
      result: trimmedResult,
    });
  }

  recordPlanText(delta: string): void {
    if (delta) {
      this.planText += delta;
    }
  }

  recordPendingDiff(diff: PendingDiff): void {
    if (diff.path && isSecretPath(diff.path)) {
      return; // Never record secret files
    }
    if (diff.changes) {
      for (const ch of diff.changes) {
        if (typeof ch.path === 'string' && isSecretPath(ch.path)) {
          return;
        }
      }
    }
    this.pendingDiffs.push(diff);
  }

  getUniqueFilesCount(): number {
    return this.uniqueFilesRead.size;
  }

  getUniqueFiles(): string[] {
    return Array.from(this.uniqueFilesRead);
  }

  hasData(): boolean {
    return (
      this.completedReadOnlyCalls.length > 0 ||
      this.planText.trim().length > 0 ||
      this.pendingDiffs.length > 0
    );
  }

  buildHandoffBrief(options?: HandoffBriefOptions): string {
    const maxTokens = options?.maxTokens ?? 1200;
    const maxChars = maxTokens * 4;

    const sections: string[] = [];

    sections.push(
      '## Handoff from Previous Session (Continue Exploration)\n' +
      'The primary agent encountered an infrastructure error after completing initial exploration.\n' +
      'Do NOT repeat completed file reads or searches below. Proceed directly with the next step (usually propose_write or propose_changes).'
    );

    if (this.originalRequest) {
      sections.push(`### Original Request\n${this.originalRequest}`);
    }

    if (this.uniqueFilesRead.size > 0) {
      const fileLines: string[] = [];
      for (const filePath of this.uniqueFilesRead) {
        if (isSecretPath(filePath)) continue;
        const matchingReads = this.completedReadOnlyCalls.filter(
          (c) => c.name === 'read_file' && c.args.path === filePath
        );
        let summary = 'inspected';
        if (matchingReads.length > 0) {
          const last = matchingReads[matchingReads.length - 1]!;
          const lines = last.result.split('\n').filter(Boolean);
          if (last.args.outline) {
            summary = `outline: ${lines.slice(0, 5).join('; ')}`;
          } else {
            const preview = lines.slice(0, 4).map((l) => l.trim()).join(' ');
            summary = preview.length > 120 ? preview.slice(0, 117) + '...' : preview;
          }
        }
        fileLines.push(`- \`${filePath}\`: ${summary}`);
      }
      if (fileLines.length > 0) {
        sections.push(`### Files Already Read\n${fileLines.join('\n')}`);
      }
    }

    const searchCalls = this.completedReadOnlyCalls.filter(
      (c) => c.name === 'search_workspace' || c.name === 'search_symbols' || c.name === 'find_references'
    );
    if (searchCalls.length > 0) {
      const searchLines: string[] = [];
      for (const call of searchCalls.slice(-5)) {
        const query = String(call.args.query ?? call.args.symbol ?? '');
        const hits = call.result
          .split('\n')
          .filter((l) => l.trim() && !isSecretPath(l))
          .slice(0, 3)
          .map((l) => l.trim().slice(0, 100))
          .join(' | ');
        if (hits) {
          searchLines.push(`- ${call.name} "${query}": ${hits}`);
        }
      }
      if (searchLines.length > 0) {
        sections.push(`### Top Search Results\n${searchLines.join('\n')}`);
      }
    }

    const trimmedPlan = this.planText.trim();
    if (trimmedPlan.length > 0) {
      const planSnippet = trimmedPlan.length > 500 ? trimmedPlan.slice(0, 497) + '...' : trimmedPlan;
      sections.push(`### Primary Agent Stated Plan\n${planSnippet}`);
    }

    if (this.pendingDiffs.length > 0) {
      const diffLines: string[] = [];
      for (const pd of this.pendingDiffs) {
        if (pd.path && !isSecretPath(pd.path)) {
          diffLines.push(`- Target: \`${pd.path}\` (${pd.rationale ?? 'unapplied proposed edit'})`);
        } else if (pd.changes) {
          for (const ch of pd.changes) {
            if (typeof ch.path === 'string' && !isSecretPath(ch.path)) {
              diffLines.push(`- Target: \`${ch.path}\` (unapplied multi-file edit)`);
            }
          }
        }
      }
      if (diffLines.length > 0) {
        sections.push(`### Pending Proposals\n${diffLines.join('\n')}`);
      }
    }

    let brief = sections.join('\n\n');
    if (brief.length > maxChars) {
      brief = brief.slice(0, maxChars - 3) + '...';
    }
    return brief;
  }

  reset(): void {
    this.originalRequest = '';
    this.assembledContext = '';
    this.completedReadOnlyCalls = [];
    this.uniqueFilesRead.clear();
    this.planText = '';
    this.pendingDiffs = [];
  }
}
