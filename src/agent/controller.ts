import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { describeToolCall, runTurn, toolName } from '../forge/turnRunner';
import type { AgentUi, ApprovalHandler } from './types';
import { CancelledError, ForgeFailure, IterationLimitError, isIterationLimitError, runWithFallback, isOverloadedError, isStallError, isConfigError, configHint, type FallbackTarget } from './resilience';
import { RunMetricsCollector, type RunMetrics } from '../metrics';
import { computeHunks } from '../review/hunks';
import { computeChangeConfidence } from '../review/confidence';
import { HandoffTracker } from './handoff';
import { setToolCompletionListener } from '../mcp/tools';

function isAuthenticationFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b(?:HTTP\s*)?(?:401|403)\b|\bstatus(?:\s+code)?\s*[:=]?\s*(?:401|403)\b/i.test(message);
}

function isNetworkFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ESOCKETTIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT)\b|fetch failed|failed to fetch|network(?: error| failure|error)|socket hang up|connection (?:refused|reset|timed out)|connection timeout|timed out|\btimeout\b/i.test(message);
}

function isServerFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b(?:HTTP\s*)?5\d\d\b|\bstatus(?:\s+code)?\s*[:=]?\s*5\d\d\b/i.test(message);
}

function isPayloadTooLarge(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b(?:HTTP\s*)?413\b|\bstatus(?:\s+code)?\s*[:=]?\s*413\b|payload too large|request too large|request entity too large/i.test(message);
}

export function isCircuitBreakerError(err: unknown): boolean {
  if (isIterationLimitError(err)) return false;
  return (
    isAuthenticationFailure(err) ||
    isNetworkFailure(err) ||
    isServerFailure(err) ||
    isPayloadTooLarge(err) ||
    isOverloadedError(err) ||
    isStallError(err)
  );
}

export class ModelHealthTracker {
  private unhealthyUntil = new Map<string, number>();

  constructor(
    private readonly durationMs = 5 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  isHealthy(model: string): boolean {
    const until = this.unhealthyUntil.get(model);
    if (!until) return true;
    if (this.now() >= until) {
      this.unhealthyUntil.delete(model);
      return true;
    }
    return false;
  }

  markUnhealthy(model: string): void {
    this.unhealthyUntil.set(model, this.now() + this.durationMs);
  }

  markHealthy(model: string): void {
    this.unhealthyUntil.delete(model);
  }

  reset(): void {
    this.unhealthyUntil.clear();
  }

  getUnhealthyModels(): string[] {
    const list: string[] = [];
    for (const [m, until] of this.unhealthyUntil.entries()) {
      if (this.now() < until) list.push(m);
      else this.unhealthyUntil.delete(m);
    }
    return list;
  }
}

export interface ControllerDeps {
  getClient: () => TrueForge;
  approvals: ApprovalHandler;
  agents: () => {
    primary: string;
    primaryModel?: string;
    fallback?: string;
    fallbackModel?: string;
    fallbackModels?: string[];
  };
  retries?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Extra cleanup on cancel (e.g. discard queued proposals). */
  onCancel?: () => void;
  onRunStart?: () => void;
  prepare?: () => Promise<void>;
  sessionId?: string | (() => string | undefined);
  onSessionCreated?: (sessionId: string) => void;
  logError?: (err: unknown) => void;
  logAttempt?: (line: string) => void;
  now?: () => number;
  circuitBreakerDurationMs?: number;
  onMetrics?: (metrics: RunMetrics) => void;
  logMetrics?: (summary: string) => void;
  faultInjection?: string | boolean;
  verifyAndRepair?: () => Promise<{ ok: boolean; errors?: string }>;
  maxRepairRounds?: number;
  fallbackContextBudget?: number;
  firstTokenTimeoutMs?: number;
  stallTimeoutMs?: number;
  failoverBudgetMs?: number;
}

export function isConnectionError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return /(?:fetch failed|econnrefused|econnreset|enotfound|etimedout|connection refused|connection reset|connection timeout|connect econnrefused|failed to fetch|network\s*error|socket hang up)/i.test(raw);
}

export function sanitizeReason(err: unknown): string {
  if (isConnectionError(err)) {
    return 'could not reach the model';
  }
  const raw = err instanceof Error ? err.message : String(err);
  let firstLine = raw.split(/[\r\n]+/)[0]?.trim() || 'unknown error';
  firstLine = firstLine
    .replace(/\s+at\s+(?:[a-zA-Z0-9_$.<>]+\s+)?\(?(?:node:|[A-Za-z]:[\\/]|(?:\.?[\\/])|\S+\.[a-zA-Z0-9]+:\d+|internal\/).*/g, '')
    .replace(/(?:Bearer\s+|(?:api[-_ ]?)?token\s*[:=]?\s*|(?:api[-_ ]?)?(?:key|secret)\s*[:=]\s*)[a-zA-Z0-9_\-\.]+/gi, '[REDACTED]')
    .replace(/authorization:\s*[^\s]+/gi, 'authorization: [REDACTED]')
    .replace(/\b(?:sk-|gsk_|AIza)[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .trim();
  if (firstLine.length > 120) {
    firstLine = firstLine.slice(0, 117) + '...';
  }
  return firstLine;
}

function sleepForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

const isMutatingTool = (n: string) => /(?:propose_write|propose_changes|run_command|run_tests)$/.test(n);

/**
 * Drives one user request end to end: session -> turn -> (approvals -> new turn)* -> done.
 * Independent of VS Code so it can be unit-tested with a fake TrueForge client.
 */
export class AgentController {
  private running = false;
  private cancelled = false;
  private abort = new AbortController();
  private sessionId: string | undefined;
  private approvedOperations = 0;
  private primaryUnhealthyUntil = 0;
  private primaryUnavailableNoticeShown = false;
  private handoffTracker = new HandoffTracker();
  private modelHealth: ModelHealthTracker;
  private attemptCount = 0;
  private readonly circuitBreakerDurationMs: number;
  private readonly now: () => number;

  constructor(private d: ControllerDeps) {
    this.circuitBreakerDurationMs = d.circuitBreakerDurationMs ?? 5 * 60 * 1000;
    this.now = d.now ?? Date.now;
    this.modelHealth = new ModelHealthTracker(this.circuitBreakerDurationMs, this.now);
  }

  get busy(): boolean { return this.running; }

  getHandoffTracker(): HandoffTracker {
    return this.handoffTracker;
  }

  getModelHealthTracker(): ModelHealthTracker {
    return this.modelHealth;
  }

  isPrimaryHealthy(): boolean {
    const cfg = this.d.agents();
    const primaryModel = cfg.primaryModel ?? cfg.primary;
    return this.now() >= this.primaryUnhealthyUntil && this.modelHealth.isHealthy(primaryModel);
  }

  resetCircuitBreaker(): void {
    this.primaryUnhealthyUntil = 0;
    this.primaryUnavailableNoticeShown = false;
    this.modelHealth.reset();
  }

  async run(
    request: string,
    ui: AgentUi,
    agentOverride?: string,
    rebuildRequest?: (agent: string) => Promise<string>,
  ): Promise<void> {
    if (this.running) { ui.finished({ status: 'error', message: 'Forge is already working on a request.' }); return; }
    this.attemptCount = 0;
    this.running = true;
    this.cancelled = false;
    this.abort = new AbortController();
    this.approvedOperations = 0;
    this.handoffTracker = new HandoffTracker(request);
    setToolCompletionListener((name, args, res) => {
      if (res.isError) return;
      const text = res.content.map((c) => c.text).join('\n').trim();
      this.handoffTracker.recordReadOnlyCall(name, args, text);
    });
    let clientToolResponses = 0;
    this.d.onRunStart?.();
    const cfg = this.d.agents();
    const primaryAgent = agentOverride ?? cfg.primary;
    const primaryModel = cfg.primaryModel ?? primaryAgent;
    const primaryTarget: FallbackTarget = { agent: primaryAgent, model: primaryModel };

    const fallbackTargets: FallbackTarget[] = [];
    if (cfg.fallbackModels && cfg.fallbackModels.length > 0) {
      for (const m of cfg.fallbackModels) {
        fallbackTargets.push({ agent: cfg.fallback ?? 'forge-agent-fallback', model: m });
      }
    } else if (cfg.fallback) {
      fallbackTargets.push({ agent: cfg.fallback, model: cfg.fallbackModel ?? cfg.fallback });
    }

    const isPrimaryHealthy = this.isPrimaryHealthy();

    let chosenPrimary: FallbackTarget = primaryTarget;
    let chosenFallbacks: FallbackTarget[] = fallbackTargets;

    if (fallbackTargets.length > 0 && !isPrimaryHealthy) {
      const healthyFallbacks = fallbackTargets.filter((t) => this.modelHealth.isHealthy(t.model ?? t.agent));
      const firstHealthy = healthyFallbacks[0] ?? fallbackTargets[0]!;
      chosenPrimary = firstHealthy;
      chosenFallbacks = fallbackTargets.filter((t) => (t.model ?? t.agent) !== (firstHealthy.model ?? firstHealthy.agent));
      if (!this.primaryUnavailableNoticeShown) {
        ui.notice('Primary unavailable, using fallback');
        this.primaryUnavailableNoticeShown = true;
      }
    }

    let primaryFailed = false;
    const metricsCollector = new RunMetricsCollector(this.now);
    metricsCollector.recordInput(request);

    try {
      const outcome = await runWithFallback<'done' | 'cancelled'>({
        primary: chosenPrimary,
        fallbacks: chosenFallbacks,
        retries: this.d.retries ?? 2,
        backoffMs: this.d.backoffMs ?? 1000,
        failoverBudgetMs: this.d.failoverBudgetMs ?? 45_000,
        now: this.now,
        sleep: this.d.sleep ?? ((ms) => sleepForRetry(ms, this.abort.signal)),
        isCancelled: () => this.cancelled,
        canRetry: () => this.approvedOperations === 0,
        shouldFallbackImmediately: (err) => !isOverloadedError(err) && (isAuthenticationFailure(err) || isNetworkFailure(err) || isServerFailure(err) || isPayloadTooLarge(err) || isStallError(err)),
        isModelHealthy: (m) => this.modelHealth.isHealthy(m),
        onModelOverloadedOrStalled: (modelKey, err) => {
          this.modelHealth.markUnhealthy(modelKey);
          if (modelKey === primaryModel || modelKey === primaryAgent) {
            this.primaryUnhealthyUntil = this.now() + this.circuitBreakerDurationMs;
          }
        },
        attempt: (agent, target) => this.attempt(
          agent,
          target?.model ?? agent,
          request,
          ui,
          rebuildRequest,
          () => ++clientToolResponses,
          metricsCollector,
          primaryAgent,
        ),
        onRetry: (agent, n, err, target) => {
          this.d.logError?.(err);
          const reason = sanitizeReason(err);
          const modelName = target?.model ?? agent;
          const attemptNum = Math.max(1, this.attemptCount);
          ui.notice(`Attempt ${attemptNum}: Request to "${modelName}" failed (${reason}), retrying (${n})...`);
        },
        onFallback: (err, fromTarget, toTarget) => {
          primaryFailed = true;
          const failedModel = fromTarget?.model ?? fromTarget?.agent ?? primaryModel;
          const nextModel = toTarget?.model ?? toTarget?.agent ?? (cfg.fallbackModel ?? cfg.fallback ?? 'fallback');
          if (isCircuitBreakerError(err)) {
            this.primaryUnhealthyUntil = this.now() + this.circuitBreakerDurationMs;
            this.modelHealth.markUnhealthy(failedModel);
            this.primaryUnavailableNoticeShown = false;
          }
          const reason = sanitizeReason(err);
          const attemptNum = Math.max(1, this.attemptCount);
          if (isConfigError(err)) {
            ui.notice(configHint(failedModel));
          } else {
            ui.notice(`Attempt ${attemptNum} to "${failedModel}" failed (${reason})`);
          }
          ui.notice(`Primary model failed, using fallback: ${nextModel}`);
          const filesCount = this.handoffTracker.getUniqueFilesCount();
          const reusingStr = filesCount > 0 ? ` (reusing ${filesCount} files already read)` : '';
          ui.notice(`Primary unavailable, continuing on fallback${reusingStr}`);
        },
      });
      if (chosenPrimary.agent === primaryAgent && !primaryFailed && outcome === 'done') {
        this.primaryUnhealthyUntil = 0;
        this.primaryUnavailableNoticeShown = false;
      }
      ui.finished(outcome === 'cancelled' ? this.cancelInfo() : { status: 'done' });
    } catch (e) {
      if (isIterationLimitError(e)) {
        ui.finished({
          status: 'error',
          message: 'The agent reached its step limit before finishing. No files were changed. You can run the request again.',
        });
        return;
      }
      if (chosenPrimary.agent === primaryAgent && isCircuitBreakerError(e)) {
        this.primaryUnhealthyUntil = this.now() + this.circuitBreakerDurationMs;
        this.modelHealth.markUnhealthy(primaryModel);
        this.primaryUnavailableNoticeShown = false;
      }
      if (e instanceof CancelledError) ui.finished(this.cancelInfo());
      else {
        const base = e instanceof ForgeFailure ? e.message : `Forge could not complete the request (${sanitizeReason(e)}).`;
        const alreadyMentionsWorkspace = /no (?:files|changes) were (?:changed|made)/i.test(base);
        const suffix = alreadyMentionsWorkspace
          ? ''
          : ` ${this.approvedOperations ? `${this.approvedOperations} approved operation(s) may have completed; inspect the workspace and use "Forge: Undo last applied change" to revert.` : 'No changes were made to your workspace.'}`;
        ui.finished({ status: 'error', message: `${base}${suffix}` });
      }
    } finally {
      setToolCompletionListener(undefined);
      this.d.approvals.cancelAll();
      this.running = false;
      this.sessionId = undefined;
      const metrics = metricsCollector.finish();
      if (!metrics.agentAnswered) {
        metrics.agentAnswered = primaryFailed ? (chosenFallbacks[0]?.agent ?? chosenPrimary.agent) : chosenPrimary.agent;
      }
      ui.metrics?.(metrics);
      this.d.onMetrics?.(metrics);
      this.d.logMetrics?.(metricsCollector.formatSummary(metrics));
    }
  }

  /** Stop: cancel the server run, abort local approvals, discard queued proposals, clear the review UI. */
  async cancel(): Promise<void> {
    if (!this.running) return;
    this.cancelled = true;
    this.abort.abort();
    this.d.approvals.cancelAll();
    this.d.onCancel?.();
    const sid = this.sessionId;
    if (sid) { try { await this.d.getClient().sessions.cancel(sid, {}); } catch { /* idempotent; stream ends by itself */ } }
  }

  private cancelInfo() {
    return { status: 'cancelled' as const, message: this.approvedOperations ? `Cancelled - ${this.approvedOperations} approved operation(s) may have completed before you stopped.` : 'Cancelled - no changes applied' };
  }

  private async attempt(
    agent: string,
    model: string,
    request: string,
    ui: AgentUi,
    rebuildRequest?: (agent: string) => Promise<string>,
    countClientToolResponse?: () => number,
    metricsCollector?: RunMetricsCollector,
    primaryAgent?: string,
  ): Promise<'done' | 'cancelled'> {
    this.attemptCount++;
    this.d.approvals.cancelAll();
    this.sessionId = undefined;
    await this.d.prepare?.();
    if (this.cancelled) return 'cancelled';

    const pAgent = primaryAgent ?? this.d.agents().primary;
    if (this.d.faultInjection && this.d.faultInjection !== 'none' && agent === pAgent) {
      const mode = String(this.d.faultInjection);
      if (mode === 'auth' || mode === 'true') {
        throw new Error('HTTP 401 Unauthorized (fault injection)');
      }
      if (mode === 'network') {
        throw new Error('ECONNREFUSED 127.0.0.1:8790 (fault injection)');
      }
      if (mode === 'server') {
        throw new Error('HTTP 500 Internal Server Error (fault injection)');
      }
      if (mode === 'timeout') {
        throw new Error('Connection timeout (fault injection)');
      }
    }

    const client = this.d.getClient();
    let sid = typeof this.d.sessionId === 'function' ? this.d.sessionId() : this.d.sessionId;
    if (!sid) {
      const { data: session } = await client.sessions.create({ agent: { name: agent } }, { abortSignal: this.abort.signal });
      sid = session.id;
      this.d.onSessionCreated?.(sid);
    }
    this.sessionId = sid;
    ui.session?.(sid);

    const attemptLog = `[forge] Attempt ${this.attemptCount}: session=${sid} agent=${agent} model=${model}`;
    this.d.logAttempt?.(attemptLog);
    this.d.logMetrics?.(attemptLog);

    if (this.cancelled) { await client.sessions.cancel(sid, {}).catch(() => {}); return 'cancelled'; }

    let messageContent = rebuildRequest ? await rebuildRequest(agent) : request;
    const isFailover = this.attemptCount > 1 || agent === this.d.agents().fallback || agent !== pAgent;
    if (isFailover && this.handoffTracker.hasData()) {
      const fallbackBudget = this.d.fallbackContextBudget ?? 1200;
      const brief = this.handoffTracker.buildHandoffBrief({ maxTokens: fallbackBudget });
      messageContent = `${brief}\n\n${messageContent}`;
    }
    let input: TrueForgeApi.TurnInputItem[] = [{ type: 'user.message', content: messageContent }];
    let hadToolCalls = false;
    let hadProposeWrite = false;
    let readOnlyToolCalls = 0;
    let readOnlyReminderEmitted = false;
    let repairRounds = 0;
    const maxRepairRounds = this.d.maxRepairRounds ?? 2;

    for (let round = 0; round < 200; round++) {
      metricsCollector?.recordModelTurn();
      let turnReadOnlyCalls = 0;
      const res = await runTurn(client, sid, input, {
        onTextDelta: (id, t) => {
          metricsCollector?.recordTextDelta(t);
          this.handoffTracker.recordPlanText(t);
          ui.textDelta(id, t);
        },
        onEventLine: (line) => ui.eventLine?.(line),
        onToolCall: (n, tc) => {
          hadToolCalls = true;
          metricsCollector?.recordToolStart(n);
          if (tc?.function?.arguments) {
            try {
              const parsed = JSON.parse(tc.function.arguments);
              if (parsed && typeof parsed === 'object') {
                if (n === 'propose_write' || n === 'propose_changes') {
                  this.handoffTracker.recordPendingDiff({
                    path: typeof parsed.path === 'string' ? parsed.path : '',
                    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : undefined,
                    edits: Array.isArray(parsed.edits) ? parsed.edits : undefined,
                    new_content: typeof parsed.new_content === 'string' ? parsed.new_content : undefined,
                    changes: Array.isArray(parsed.changes) ? parsed.changes : undefined,
                  });
                } else {
                  this.handoffTracker.recordReadOnlyCall(n, parsed, '');
                }
              }
            } catch {}
          }
          if (n === 'propose_write' || n === 'propose_changes') hadProposeWrite = true;
          if (!isMutatingTool(n)) {
            turnReadOnlyCalls++;
            readOnlyToolCalls++;
            if ((turnReadOnlyCalls === 8 || readOnlyToolCalls === 8) && !readOnlyReminderEmitted) {
              readOnlyReminderEmitted = true;
              ui.notice('Gentle reminder: 8 read-only tool calls reached. Please list target files and proceed to propose_write.');
            }
          }
          ui.toolCall(n);
        },
      }, this.abort.signal, {
        firstTokenTimeoutMs: this.d.firstTokenTimeoutMs ?? 25000,
        stallTimeoutMs: this.d.stallTimeoutMs ?? 20000,
        onStall: async () => {
          try { await client.sessions.cancel(sid!, {}); } catch {}
          this.d.approvals.cancelAll();
          this.d.onCancel?.();
        },
      });
      metricsCollector?.recordToolEnd();
      if (this.cancelled || res.status === 'cancelled') return 'cancelled';
      if (res.status === 'error') {
        const errMsg = res.error ?? 'the turn ended with an error';
        if (isIterationLimitError(errMsg)) throw new IterationLimitError(errMsg);
        throw new Error(errMsg);
      }

      for (const ev of res.events.values()) {
        if (ev.type === 'model.message') {
          for (const tc of ev.toolCalls ?? []) {
            hadToolCalls = true;
            const name = toolName(tc);
            if (name === 'propose_write' || name === 'propose_changes') hadProposeWrite = true;
            if (name === 'call_tool' || tc.function?.name === 'call_tool') {
              try {
                const parsed = JSON.parse(tc.function?.arguments || '{}');
                if (parsed.tool_name === 'propose_write' || parsed.tool_name === 'propose_changes' || parsed.input?.tool_name === 'propose_write' || parsed.input?.tool_name === 'propose_changes') {
                  hadProposeWrite = true;
                }
              } catch {}
            }
          }
        }
      }

      if (res.status === 'paused') {
        const items: TrueForgeApi.TurnInputItem[] = [];

        if (res.toolResponses && res.toolResponses.length > 0) {
          const times = countClientToolResponse ? countClientToolResponse() : 1;
          if (times > 2) {
            throw new Error('Unsupported client-side tool was called too many times (limit: 2 per run).');
          }
          for (const tr of res.toolResponses) {
            items.push({
              type: 'user.tool_response',
              threadId: tr.threadId,
              toolCallId: tr.toolCallId,
              content: 'No user is available to answer. Proceed with your best judgment and use propose_write for edits.',
            });
          }
        }

        for (const a of res.approvals) {
          const info = describeToolCall(res.events, a);
          if (info?.name === 'propose_write' || info?.name === 'propose_changes') {
            hadProposeWrite = true;
            if (info.name === 'propose_write' && typeof info.args.path === 'string') {
              this.handoffTracker.recordPendingDiff({
                path: info.args.path,
                rationale: typeof info.args.rationale === 'string' ? info.args.rationale : undefined,
                edits: Array.isArray(info.args.edits) ? info.args.edits : undefined,
                new_content: typeof info.args.new_content === 'string' ? info.args.new_content : undefined,
              });
              let conf: { tag: string; score: number } | undefined;
              try {
                if (typeof info.args.old_text === 'string' && typeof info.args.new_text === 'string') {
                  const hunks = computeHunks(info.args.old_text, info.args.new_text);
                  conf = computeChangeConfidence({ oldText: info.args.old_text, newText: info.args.new_text, hunks, isNew: !info.args.old_text });
                }
              } catch {}
              ui.diffPreview?.({
                path: info.args.path,
                rationale: typeof info.args.rationale === 'string' ? info.args.rationale : undefined,
                confidence: conf,
              });
            } else if (info.name === 'propose_changes' && Array.isArray(info.args.changes)) {
              this.handoffTracker.recordPendingDiff({
                path: '',
                rationale: typeof info.args.rationale === 'string' ? info.args.rationale : undefined,
                changes: info.args.changes,
              });
              for (const ch of info.args.changes) {
                if (ch && typeof ch.path === 'string') {
                  let conf: { tag: string; score: number } | undefined;
                  try {
                    if (typeof ch.old_text === 'string' && typeof ch.new_text === 'string') {
                      const hunks = computeHunks(ch.old_text, ch.new_text);
                      conf = computeChangeConfidence({ oldText: ch.old_text, newText: ch.new_text, hunks, isNew: !ch.old_text });
                    }
                  } catch {}
                  ui.diffPreview?.({
                    path: ch.path,
                    rationale: typeof ch.rationale === 'string' ? ch.rationale : (typeof info.args.rationale === 'string' ? info.args.rationale : undefined),
                    confidence: conf,
                  });
                }
              }
            }
          }
          const decision = info
            ? await this.d.approvals.decide(info, this.abort.signal)
            : { status: 'deny' as const, reason: 'Could not read the tool call arguments.' };
          if (this.cancelled) return 'cancelled'; // nothing is sent after a cancel
          if (decision.status === 'allow' && info && isMutatingTool(info.name)) this.approvedOperations++;
          items.push({ type: 'user.tool_approval', threadId: a.threadId, toolCallId: a.toolCallId, approval: decision });
        }
        input = items; // resume turn with approvals and/or tool responses
        continue;
      }
      if (res.status === 'done') {
        metricsCollector?.setAgentAnswered(agent);
        if (hadProposeWrite && this.approvedOperations > 0 && repairRounds < maxRepairRounds && this.d.verifyAndRepair) {
          const v = await this.d.verifyAndRepair();
          if (!v.ok && v.errors) {
            repairRounds++;
            ui.notice(`Verification detected errors (repair round ${repairRounds}/${maxRepairRounds}). Repairing...`);
            input = [{ type: 'user.message', content: `## Verification Errors\n${v.errors}\n\nPlease fix the errors above using propose_write.` }];
            continue;
          }
        }
        const isFallback = agent === this.d.agents().fallback;
        if (isFallback && hadToolCalls && !hadProposeWrite) {
          ui.notice('Fallback model stopped early');
        }
        return 'done';
      }
      throw new Error('the response stream ended unexpectedly');
    }
    throw new Error('too many approval rounds');
  }
}
