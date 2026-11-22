/** Raised when every model (primary, then fallback) failed. Message is safe to show the user. */
export class ForgeFailure extends Error {}
/** Raised when the user cancelled while we were waiting/backing off. */
export class CancelledError extends Error {}
/** Raised when TrueForge reaches its agent iteration / step limit. */
export class IterationLimitError extends Error {
  constructor(message = 'The agent reached its step limit before finishing.') {
    super(message);
    this.name = 'IterationLimitError';
  }
}

export function isIterationLimitError(err: unknown): boolean {
  if (err instanceof IterationLimitError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /iteration limit/i.test(message);
}

export interface FallbackTarget {
  agent: string;
  model?: string;
}

export interface FallbackOptions<T> {
  primary: string | FallbackTarget;
  fallback?: string | FallbackTarget;
  fallbacks?: (string | FallbackTarget)[];
  /** Retries per agent after the first try (spec: 2). Backoff is backoffMs * 2^n. */
  retries: number;
  backoffMs: number;
  sleep: (ms: number) => Promise<void>;
  attempt: (agent: string, target?: FallbackTarget) => Promise<T>;
  isCancelled: () => boolean;
  canRetry?: () => boolean;
  shouldFallbackImmediately?: (err: unknown) => boolean;
  onRetry?: (agent: string, retryNo: number, err: unknown, target?: FallbackTarget) => void;
  onFallback?: (err: unknown, fromTarget?: FallbackTarget, toTarget?: FallbackTarget) => void;
  failoverBudgetMs?: number;
  now?: () => number;
  isModelHealthy?: (model: string) => boolean;
  onModelOverloadedOrStalled?: (model: string, err: unknown) => void;
}

/** Short, stack-free reason for the one error message the user sees. */
export function briefReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/(?:fetch failed|econnrefused|econnreset|enotfound|etimedout|connection refused|connection reset|connection timeout|connect econnrefused|failed to fetch|network\s*error|socket hang up)/i.test(raw)) {
    return 'could not reach the model';
  }
  let line = raw.split(/[\r\n]+/)[0]!.trim();
  line = line
    .replace(/\s+at\s+(?:[a-zA-Z0-9_$.<>]+\s+)?\(?(?:node:|[A-Za-z]:[\\/]|(?:\.?[\\/])|\S+\.[a-zA-Z0-9]+:\d+|internal\/).*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/(?:Bearer\s+|(?:api[-_ ]?)?token\s*[:=]?\s*|(?:api[-_ ]?)?(?:key|secret)\s*[:=]\s*)[a-zA-Z0-9_\-\.]+/gi, '[REDACTED]')
    .replace(/authorization:\s*[^\s]+/gi, 'authorization: [REDACTED]')
    .replace(/\b(?:sk-|gsk_|AIza)[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .trim()
    .slice(0, 160);
  return line;
}

/** Quota retry hints can arrive in turn.done text rather than HTTP headers. */
function retryDelay(error: unknown, exponentialMs: number, maxCapMs = 12_000): number {
  const message = error instanceof Error ? error.message : String(error);
  if (!/\b429\b/.test(message)) return Math.min(maxCapMs, exponentialMs);
  const hint = /(?:retry|try\s+again)\s+in\s+(\d+(?:\.\d+)?)s\b/i.exec(message);
  if (!hint) return Math.min(maxCapMs, exponentialMs);
  const seconds = Number(hint[1]);
  if (!Number.isFinite(seconds)) return Math.min(maxCapMs, exponentialMs);
  return Math.max(exponentialMs, Math.min(maxCapMs, Math.ceil(seconds * 1000) + 250));
}

/** Detects HTTP 429 quota / rate limit errors. */
export function isQuotaError(err: unknown): boolean {
  if (!err) return false;
  const status = (err as any)?.status ?? (err as any)?.statusCode ?? (err as any)?.response?.status;
  if (status === 429) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /\b429\b|rate[-_ ]?limit|quota|too many requests|resource[ _]exhausted/i.test(message);
}

/** Detects configuration errors (e.g. HTTP 422 Unprocessable Entity, missing model/provider). */
export function isConfigError(err: unknown): boolean {
  if (!err) return false;
  const status = (err as any)?.status ?? (err as any)?.statusCode ?? (err as any)?.response?.status;
  if (status === 422) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /unprocessable ?entity|configure the required models|failed to sync|provider not configured|unknown model|model .*not (found|configured)/i.test(message);
}

export type ErrorClass = 'config' | 'auth' | 'rate-limit' | 'overloaded' | 'stall' | 'network' | 'other';

export function isNetworkError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  return /(?:fetch failed|econnrefused|econnreset|enotfound|etimedout|connection refused|connection reset|connection timeout|connect econnrefused|failed to fetch|network\s*error|socket hang up)/i.test(message);
}

export function isAuthError(err: unknown): boolean {
  if (!err) return false;
  const status = (err as any)?.status ?? (err as any)?.statusCode ?? (err as any)?.response?.status;
  if (status === 401 || status === 403) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /\b(?:401|403)\b|unauthorized|forbidden/i.test(message);
}

export function classifyError(err: unknown): ErrorClass {
  if (isConfigError(err)) return 'config';
  if (isStallError(err)) return 'stall';
  if (isOverloadedError(err)) return 'overloaded';
  if (isQuotaError(err)) return 'rate-limit';
  if (isAuthError(err)) return 'auth';
  if (isNetworkError(err)) return 'network';
  return 'other';
}

export function configHint(model: string): string {
  return `Model "${model}" is not configured in TrueForge. Add that provider and model in the TrueForge settings (http://localhost:8790) or run scripts/configure-provider.cjs, then try again. Skipping it and trying the next model.`;
}

/** Permanent errors that should fail fast without retrying. */
export function isPermanentError(err: unknown): boolean {
  if (!err) return false;
  if (isConfigError(err)) return true;
  const status = (err as any)?.status ?? (err as any)?.statusCode ?? (err as any)?.response?.status;
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 413 || status === 422) return true;
  const message = err instanceof Error ? err.message : String(err);
  if (/\b(?:400|401|403|404|413|422)\b/.test(message)) return true;
  if (/unauthorized|forbidden|not found|too large|payload too large|request too large/i.test(message) && !/429/i.test(message)) return true;
  return false;
}

/** Detects overloaded model errors: 503/UNAVAILABLE "high demand" and ECONNRESET/terminated. */
export function isOverloadedError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  if (/high[-_ ]?demand|overloaded/i.test(message)) return true;
  if (/\b(?:ECONNRESET|terminated|socket hang up|connection reset)\b/i.test(message)) return true;
  return false;
}

/** Detects watchdog timeout / stall errors. */
export function isStallError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  return /stall timeout|first token timeout|no stream event|no response within/i.test(message);
}

/**
 * try primary (1 + `retries` times with exponential backoff) -> switch to the fallback agent
 * (fresh session, same request, handled by `attempt`) -> else throw ONE clear ForgeFailure.
 * A cancelled run is never retried.
 */
export async function runWithFallback<T>(o: FallbackOptions<T>): Promise<T> {
  const normalizeTarget = (t: string | FallbackTarget): FallbackTarget => {
    return typeof t === 'string' ? { agent: t, model: t } : { agent: t.agent, model: t.model ?? t.agent };
  };

  const rawTargets: FallbackTarget[] = [];
  rawTargets.push(normalizeTarget(o.primary));
  if (o.fallbacks && o.fallbacks.length > 0) {
    for (const fb of o.fallbacks) {
      rawTargets.push(normalizeTarget(fb));
    }
  } else if (o.fallback && o.fallback !== o.primary) {
    rawTargets.push(normalizeTarget(o.fallback));
  }

  const now = o.now ?? Date.now;
  const startTime = now();
  const failoverBudgetMs = o.failoverBudgetMs ?? 45_000;
  const checkBudget = () => {
    if (now() - startTime >= failoverBudgetMs) {
      throw new ForgeFailure(
        `Failover budget exceeded (${Math.round(failoverBudgetMs / 1000)}s). No changes were made to your workspace.`
      );
    }
  };

  // Skip unhealthy models for later requests if healthy ones exist
  let targets = rawTargets;
  if (o.isModelHealthy) {
    const healthyTargets = rawTargets.filter((t) => o.isModelHealthy!(t.model ?? t.agent));
    if (healthyTargets.length > 0) {
      targets = healthyTargets;
    }
  }

  const modelSessionsInThisRun = new Map<string, number>();

  let lastErr: unknown;
  let primaryErr: unknown;
  let fallbackErr: unknown;
  let primaryRetried = false;
  let fallbackWaitMs = 0;
  const MAX_FALLBACK_WAIT_MS = 30_000;

  for (let a = 0; a < targets.length; a++) {
    const target = targets[a]!;
    const modelKey = target.model ?? target.agent;
    const isFallback = a > 0;
    const wasInitiallyHealthy = !o.isModelHealthy || o.isModelHealthy(modelKey);

    checkBudget();

    // Never start more than one session on the same unhealthy model per request
    if (!wasInitiallyHealthy && (modelSessionsInThisRun.get(modelKey) ?? 0) >= 1) {
      continue;
    }

    // Avoid double retry stacking: if primary already retried, fallback gets 0 retries
    const maxRetries = isFallback && primaryRetried ? 0 : o.retries;

    for (let i = 0; i <= maxRetries; i++) {
      checkBudget();
      if (o.isCancelled()) throw new CancelledError();

      if (!wasInitiallyHealthy && (modelSessionsInThisRun.get(modelKey) ?? 0) >= 1) {
        break;
      }

      modelSessionsInThisRun.set(modelKey, (modelSessionsInThisRun.get(modelKey) ?? 0) + 1);

      try {
        return await o.attempt(target.agent, target);
      } catch (e) {
        lastErr = e;
        if (a === 0) primaryErr = e;
        else fallbackErr = e;
        if (o.isCancelled()) throw new CancelledError();
        if (isIterationLimitError(e)) {
          throw e instanceof IterationLimitError ? e : new IterationLimitError(e instanceof Error ? e.message : String(e));
        }
        if (o.canRetry && !o.canRetry()) throw new ForgeFailure('The run stopped after an approved operation; automatic replay was skipped.');
        if (a === 0 && o.shouldFallbackImmediately?.(e)) break;

        if (a === 0 && i > 0) primaryRetried = true;

        // Fail fast on permanent errors: do not retry them before falling back or failing
        if (isPermanentError(e)) {
          break;
        }

        // Stall error: mark model unhealthy, 0 retries, switch immediately
        if (isStallError(e)) {
          o.onModelOverloadedOrStalled?.(modelKey, e);
          break;
        }

        // Overloaded error (503 / UNAVAILABLE / high demand / ECONNRESET / terminated):
        // at most ONE quick retry (<=2s), then switch to next model in ordered fallback list
        if (isOverloadedError(e)) {
          if (i >= 1 || !wasInitiallyHealthy) {
            o.onModelOverloadedOrStalled?.(modelKey, e);
            break;
          }
          checkBudget();
          const delay = Math.min(2000, o.backoffMs * 2 ** i);
          const remainingBudget = failoverBudgetMs - (now() - startTime);
          if (remainingBudget <= 0) {
            checkBudget();
          }
          const actualDelay = Math.min(delay, remainingBudget);
          o.onRetry?.(target.agent, i + 1, e, target);
          await o.sleep(actualDelay);
          o.onModelOverloadedOrStalled?.(modelKey, e);
          continue;
        }

        if (i < maxRetries) {
          checkBudget();
          let delay = retryDelay(e, o.backoffMs * 2 ** i, isFallback ? 30_000 : 12_000);
          if (isFallback) {
            const remaining = MAX_FALLBACK_WAIT_MS - fallbackWaitMs;
            if (remaining <= 0) {
              break;
            }
            delay = Math.min(delay, remaining);
            fallbackWaitMs += delay;
          }
          const remainingBudget = failoverBudgetMs - (now() - startTime);
          if (remainingBudget <= 0) {
            checkBudget();
          }
          delay = Math.min(delay, remainingBudget);
          o.onRetry?.(target.agent, i + 1, e, target);
          await o.sleep(delay);
        }
      }
    }
    if (a < targets.length - 1) {
      o.onFallback?.(lastErr, target, targets[a + 1]);
    }
  }
  checkBudget();
  if (targets.length > 1) {
    if (isQuotaError(primaryErr) || isQuotaError(fallbackErr)) {
      throw new ForgeFailure(
        `Primary model failed (${briefReason(primaryErr ?? lastErr)}); fallback model failed (${briefReason(fallbackErr ?? lastErr)}). No files were changed.`
      );
    }
    throw new ForgeFailure(`Both the primary and fallback models failed (${briefReason(lastErr)}).`);
  }
  throw new ForgeFailure(`The model request failed (${briefReason(lastErr)}).`);
}
