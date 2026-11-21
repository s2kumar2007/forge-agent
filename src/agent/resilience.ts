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

export interface FallbackOptions<T> {
  primary: string;
  fallback?: string;
  /** Retries per agent after the first try (spec: 2). Backoff is backoffMs * 2^n. */
  retries: number;
  backoffMs: number;
  sleep: (ms: number) => Promise<void>;
  attempt: (agent: string) => Promise<T>;
  isCancelled: () => boolean;
  canRetry?: () => boolean;
  shouldFallbackImmediately?: (err: unknown) => boolean;
  onRetry?: (agent: string, retryNo: number, err: unknown) => void;
  onFallback?: (err: unknown) => void;
}

/** Short, stack-free reason for the one error message the user sees. */
export function briefReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
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

/** Permanent errors that should fail fast without retrying. */
export function isPermanentError(err: unknown): boolean {
  if (!err) return false;
  const status = (err as any)?.status ?? (err as any)?.statusCode ?? (err as any)?.response?.status;
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 413) return true;
  const message = err instanceof Error ? err.message : String(err);
  if (/\b(?:400|401|403|404|413)\b/.test(message)) return true;
  if (/unauthorized|forbidden|not found|too large|payload too large|request too large/i.test(message) && !/429/i.test(message)) return true;
  return false;
}

/**
 * try primary (1 + `retries` times with exponential backoff) -> switch to the fallback agent
 * (fresh session, same request, handled by `attempt`) -> else throw ONE clear ForgeFailure.
 * A cancelled run is never retried.
 */
export async function runWithFallback<T>(o: FallbackOptions<T>): Promise<T> {
  const agents = [o.primary, ...(o.fallback && o.fallback !== o.primary ? [o.fallback] : [])];
  let lastErr: unknown;
  let primaryErr: unknown;
  let fallbackErr: unknown;
  let primaryRetried = false;
  let fallbackWaitMs = 0;
  const MAX_FALLBACK_WAIT_MS = 30_000;

  for (let a = 0; a < agents.length; a++) {
    const agent = agents[a]!;
    const isFallback = a > 0;
    // Avoid double retry stacking: if primary already retried, fallback gets 0 retries
    const maxRetries = isFallback && primaryRetried ? 0 : o.retries;

    for (let i = 0; i <= maxRetries; i++) {
      if (o.isCancelled()) throw new CancelledError();
      try {
        return await o.attempt(agent);
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

        if (i < maxRetries) {
          let delay = retryDelay(e, o.backoffMs * 2 ** i, isFallback ? 30_000 : 12_000);
          if (isFallback) {
            const remaining = MAX_FALLBACK_WAIT_MS - fallbackWaitMs;
            if (remaining <= 0) {
              break;
            }
            delay = Math.min(delay, remaining);
            fallbackWaitMs += delay;
          }
          o.onRetry?.(agent, i + 1, e);
          await o.sleep(delay);
        }
      }
    }
    if (a === 0 && agents.length > 1) o.onFallback?.(lastErr);
  }
  if (agents.length > 1) {
    if (isQuotaError(primaryErr) || isQuotaError(fallbackErr)) {
      throw new ForgeFailure(
        `Primary model failed (${briefReason(primaryErr ?? lastErr)}); fallback model failed (${briefReason(fallbackErr ?? lastErr)}). No files were changed.`
      );
    }
    throw new ForgeFailure(`Both the primary and fallback models failed (${briefReason(lastErr)}).`);
  }
  throw new ForgeFailure(`The model request failed (${briefReason(lastErr)}).`);
}
