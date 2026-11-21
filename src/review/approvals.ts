import type { ApprovalDecision, ApprovalHandler, ToolCallInfo } from '../agent/types';
import { computeHunks, normalizeEol, type Hunk } from './hunks';
import { computeChangeConfidence, type ConfidenceScore } from './confidence';
import { materializeWrite } from './proposal';
import { DecisionStore, proposalKey } from './decisions';
import { PathError, resolveInsideReal, toRel } from '../workspace/paths';
import { validateCommandPaths, detectTestCommand } from '../workspace/runCommand';

export interface ReviewRequest { relPath: string; rationale: string; oldText: string; newText: string; hunks: Hunk[]; isNew: boolean; confidence?: ConfidenceScore }

/** The visual part (diff editor + hunk list). Implemented with VS Code APIs elsewhere. */
export interface ReviewUi {
  /** Resolves with the ACCEPTED hunk ids ([] = rejected all, also on abort/close). */
  reviewHunks(req: ReviewRequest, signal: AbortSignal): Promise<number[]>;
  confirmCommand(command: string, signal: AbortSignal): Promise<boolean>;
  close(): void;
}

const is = (name: string, tool: string) => name === tool || name.endsWith(tool);

export class ReviewApprovals implements ApprovalHandler {
  constructor(private d: { root: string; ui: ReviewUi; store: DecisionStore; readText: (abs: string) => Promise<string | undefined> }) {}

  cancelAll(): void { this.d.store.clear(); this.d.ui.close(); }

  async decide(call: ToolCallInfo, signal: AbortSignal): Promise<ApprovalDecision> {
    if (signal.aborted) return { status: 'deny', reason: 'Cancelled.' };
    if (is(call.name, 'propose_write')) return this.decideWrite(call, signal);
    if (is(call.name, 'propose_changes')) return this.decideChanges(call, signal);
    if (is(call.name, 'run_command') || is(call.name, 'run_tests')) {
      let cmd = String(call.args.command ?? '');
      if (is(call.name, 'run_tests')) {
        cmd = await detectTestCommand(
          this.d.root,
          call.args.framework ? String(call.args.framework) : undefined,
          call.args.test_path ? String(call.args.test_path) : undefined,
          call.args.filter ? String(call.args.filter) : undefined,
        );
      }
      if (!cmd) return { status: 'deny', reason: 'Empty command.' };
      try { await validateCommandPaths(this.d.root, cmd); } catch { return { status: 'deny', reason: 'Command references a path outside the workspace.' }; }
      const confirmed = await this.d.ui.confirmCommand(cmd, signal);
      if (!confirmed || signal.aborted) return { status: 'deny', reason: 'The command was declined or cancelled.' };
      this.d.store.permitCommand(cmd);
      return { status: 'allow' };
    }
    return { status: 'deny', reason: 'Unknown approval tool.' };
  }

  private async decideWrite(call: ToolCallInfo, signal: AbortSignal): Promise<ApprovalDecision> {
    const { path, rationale } = call.args;
    if (typeof path !== 'string') return { status: 'deny', reason: 'Invalid propose_write arguments: path is required.' };
    let abs: string;
    try { abs = await resolveInsideReal(this.d.root, path); }
    catch (e) { return { status: 'deny', reason: e instanceof PathError ? e.message : 'Invalid path.' }; }

    const existing = await this.d.readText(abs);
    let new_content: string;
    try { new_content = materializeWrite(existing, call.args); } catch (error) { return { status: 'deny', reason: error instanceof Error ? error.message : 'Invalid proposal.' }; }
    const oldText = existing ?? '';
    const reviewedText = normalizeEol(oldText, new_content);
    const hunks = computeHunks(oldText, reviewedText);
    if (hunks.length === 0) return { status: 'deny', reason: 'The proposed content is identical to the current file; nothing to change.' };
    const confidence = computeChangeConfidence({ oldText, newText: reviewedText, hunks, isNew: existing === undefined });

    const accepted = await this.d.ui.reviewHunks({ relPath: toRel(this.d.root, abs), rationale: String(rationale ?? ''), oldText, newText: reviewedText, hunks, isNew: existing === undefined, confidence }, signal);
    if (signal.aborted) return { status: 'deny', reason: 'Cancelled.' };
    if (accepted.length === 0) return { status: 'deny', reason: 'The user rejected all hunks.' };

    // The MCP handler looks this up when TrueForge executes the (now allowed) call.
    this.d.store.put(proposalKey(abs, new_content), { baseText: oldText, newText: reviewedText, acceptedHunks: accepted, totalHunks: hunks.length });
    return { status: 'allow' };
  }

  private async decideChanges(call: ToolCallInfo, signal: AbortSignal): Promise<ApprovalDecision> {
    const { changes, rationale } = call.args;
    if (!Array.isArray(changes) || changes.length === 0) {
      return { status: 'deny', reason: 'Invalid propose_changes arguments: changes array is required.' };
    }

    interface PreparedChange {
      abs: string;
      rel: string;
      oldText: string;
      newText: string;
      hunks: Hunk[];
      isNew: boolean;
      candidate: string;
    }

    const prepared: PreparedChange[] = [];

    for (const change of changes) {
      if (typeof change !== 'object' || change === null || typeof change.path !== 'string') {
        return { status: 'deny', reason: 'Invalid change: path is required.' };
      }
      let abs: string;
      try { abs = await resolveInsideReal(this.d.root, change.path); }
      catch (e) { return { status: 'deny', reason: e instanceof PathError ? e.message : 'Invalid path.' }; }

      const existing = await this.d.readText(abs);
      let candidate: string;
      try { candidate = materializeWrite(existing, change); }
      catch (error) { return { status: 'deny', reason: error instanceof Error ? error.message : 'Invalid proposal in changes.' }; }

      const oldText = existing ?? '';
      const reviewedText = normalizeEol(oldText, candidate);
      const hunks = computeHunks(oldText, reviewedText);
      if (hunks.length > 0) {
        prepared.push({
          abs,
          rel: toRel(this.d.root, abs),
          oldText,
          newText: reviewedText,
          hunks,
          isNew: existing === undefined,
          candidate,
        });
      }
    }

    if (prepared.length === 0) {
      return { status: 'deny', reason: 'The proposed changes are identical to current files; nothing to change.' };
    }

    let totalAccepted = 0;
    for (const p of prepared) {
      if (signal.aborted) return { status: 'deny', reason: 'Cancelled.' };
      const confidence = computeChangeConfidence({ oldText: p.oldText, newText: p.newText, hunks: p.hunks, isNew: p.isNew });
      const accepted = await this.d.ui.reviewHunks({
        relPath: p.rel,
        rationale: String(rationale ?? ''),
        oldText: p.oldText,
        newText: p.newText,
        hunks: p.hunks,
        isNew: p.isNew,
        confidence,
      }, signal);
      if (signal.aborted) return { status: 'deny', reason: 'Cancelled.' };
      if (accepted.length > 0) {
        totalAccepted += accepted.length;
        this.d.store.put(proposalKey(p.abs, p.candidate), {
          baseText: p.oldText,
          newText: p.newText,
          acceptedHunks: accepted,
          totalHunks: p.hunks.length,
        });
      }
    }

    if (totalAccepted === 0) {
      return { status: 'deny', reason: 'The user rejected all hunks across all proposed files.' };
    }

    return { status: 'allow' };
  }
}
