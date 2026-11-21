import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { describeToolCall, runTurn, toolName } from '../forge/turnRunner';
import type { AgentUi, ApprovalHandler } from './types';
import { CancelledError, ForgeFailure, IterationLimitError, isIterationLimitError, runWithFallback } from './resilience';
import { RunMetricsCollector, type RunMetrics } from '../metrics';

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
  return isAuthenticationFailure(err) || isNetworkFailure(err) || isServerFailure(err) || isPayloadTooLarge(err);
}

export interface ControllerDeps {
  getClient: () => TrueForge;
  approvals: ApprovalHandler;
  agents: () => { primary: string; fallback?: string; fallbackModel?: string };
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
  now?: () => number;
  circuitBreakerDurationMs?: number;
  onMetrics?: (metrics: RunMetrics) => void;
  logMetrics?: (summary: string) => void;
}

export function sanitizeReason(err: unknown): string {
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

const isMutatingTool = (n: string) => /(?:propose_write|run_command)$/.test(n);

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
  private readonly circuitBreakerDurationMs: number;
  private readonly now: () => number;

  constructor(private d: ControllerDeps) {
    this.circuitBreakerDurationMs = d.circuitBreakerDurationMs ?? 5 * 60 * 1000;
    this.now = d.now ?? Date.now;
  }

  get busy(): boolean { return this.running; }

  isPrimaryHealthy(): boolean {
    return this.now() >= this.primaryUnhealthyUntil;
  }

  resetCircuitBreaker(): void {
    this.primaryUnhealthyUntil = 0;
    this.primaryUnavailableNoticeShown = false;
  }

  async run(
    request: string,
    ui: AgentUi,
    agentOverride?: string,
    rebuildRequest?: (agent: string) => Promise<string>,
  ): Promise<void> {
    if (this.running) { ui.finished({ status: 'error', message: 'Forge is already working on a request.' }); return; }
    this.running = true;
    this.cancelled = false;
    this.abort = new AbortController();
    this.approvedOperations = 0;
    let clientToolResponses = 0;
    this.d.onRunStart?.();
    const cfg = this.d.agents();
    const primaryAgent = agentOverride ?? cfg.primary;
    const fallbackAgent = cfg.fallback;
    const isPrimaryHealthy = this.isPrimaryHealthy();

    let chosenPrimary = primaryAgent;
    let chosenFallback = fallbackAgent;

    if (fallbackAgent && !isPrimaryHealthy) {
      chosenPrimary = fallbackAgent;
      chosenFallback = undefined;
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
        fallback: chosenFallback,
        retries: this.d.retries ?? 2,
        backoffMs: this.d.backoffMs ?? 1000,
        sleep: this.d.sleep ?? ((ms) => sleepForRetry(ms, this.abort.signal)),
        isCancelled: () => this.cancelled,
        canRetry: () => this.approvedOperations === 0,
        shouldFallbackImmediately: (err) => isAuthenticationFailure(err) || isNetworkFailure(err) || isServerFailure(err) || isPayloadTooLarge(err),
        attempt: (agent) => this.attempt(agent, request, ui, rebuildRequest, () => ++clientToolResponses, metricsCollector),
        onRetry: (agent, n, err) => {
          this.d.logError?.(err);
          const reason = sanitizeReason(err);
          ui.notice(`Request to "${agent}" failed (${reason}), retrying (${n})...`);
        },
        onFallback: (err) => {
          primaryFailed = true;
          if (isCircuitBreakerError(err)) {
            this.primaryUnhealthyUntil = this.now() + this.circuitBreakerDurationMs;
            this.primaryUnavailableNoticeShown = false;
          }
          const model = sanitizeReason(new Error(cfg.fallbackModel ?? cfg.fallback ?? 'fallback'));
          ui.notice(`Primary model failed, using fallback: ${model}`);
        },
      });
      if (chosenPrimary === primaryAgent && !primaryFailed && outcome === 'done') {
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
      if (chosenPrimary === primaryAgent && isCircuitBreakerError(e)) {
        this.primaryUnhealthyUntil = this.now() + this.circuitBreakerDurationMs;
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
      this.d.approvals.cancelAll();
      this.running = false;
      this.sessionId = undefined;
      const metrics = metricsCollector.finish();
      if (!metrics.agentAnswered) {
        metrics.agentAnswered = primaryFailed ? (chosenFallback ?? chosenPrimary) : chosenPrimary;
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
    request: string,
    ui: AgentUi,
    rebuildRequest?: (agent: string) => Promise<string>,
    countClientToolResponse?: () => number,
    metricsCollector?: RunMetricsCollector,
  ): Promise<'done' | 'cancelled'> {
    this.d.approvals.cancelAll();
    this.sessionId = undefined;
    await this.d.prepare?.();
    if (this.cancelled) return 'cancelled';
    const client = this.d.getClient();
    let sid = typeof this.d.sessionId === 'function' ? this.d.sessionId() : this.d.sessionId;
    if (!sid) {
      const { data: session } = await client.sessions.create({ agent: { name: agent } }, { abortSignal: this.abort.signal });
      sid = session.id;
      this.d.onSessionCreated?.(sid);
    }
    this.sessionId = sid;
    ui.session?.(sid);
    if (this.cancelled) { await client.sessions.cancel(sid, {}).catch(() => {}); return 'cancelled'; }

    const messageContent = rebuildRequest ? await rebuildRequest(agent) : request;
    let input: TrueForgeApi.TurnInputItem[] = [{ type: 'user.message', content: messageContent }];
    let hadToolCalls = false;
    let hadProposeWrite = false;
    let readOnlyToolCalls = 0;
    let readOnlyReminderEmitted = false;

    for (let round = 0; round < 200; round++) {
      metricsCollector?.recordModelTurn();
      let turnReadOnlyCalls = 0;
      const res = await runTurn(client, sid, input, {
        onTextDelta: (id, t) => {
          metricsCollector?.recordTextDelta(t);
          ui.textDelta(id, t);
        },
        onEventLine: (line) => ui.eventLine?.(line),
        onToolCall: (n) => {
          hadToolCalls = true;
          metricsCollector?.recordToolStart(n);
          if (n === 'propose_write') hadProposeWrite = true;
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
      }, this.abort.signal);
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
            if (name === 'propose_write') hadProposeWrite = true;
            if (name === 'call_tool' || tc.function?.name === 'call_tool') {
              try {
                const parsed = JSON.parse(tc.function?.arguments || '{}');
                if (parsed.tool_name === 'propose_write' || parsed.input?.tool_name === 'propose_write') {
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
          if (info?.name === 'propose_write') hadProposeWrite = true;
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
