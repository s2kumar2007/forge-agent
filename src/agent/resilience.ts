/** Raised when every model (primary, then fallback) failed. Message is safe to show the user. */
export class ForgeFailure extends Error {}
/** Raised when the user cancelled while we were waiting/backing off. */
export class CancelledError extends Error {}

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
  onRetry?: (agent: string, retryNo: number, err: unknown) => void;
  onFallback?: (err: unknown) => void;
}

/** Short, stack-free reason for the one error message the user sees. */
export function briefReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.split('\n')[0]!.replace(/\s+/g, ' ').slice(0, 160);
}

/** Quota retry hints can arrive in turn.done text rather than HTTP headers. */
function retryDelay(error: unknown, exponentialMs: number): number {
  const message = error instanceof Error ? error.message : String(error);
  if (!/\b429\b/.test(message)) return Math.min(12_000, exponentialMs);
  const hint = /(?:retry|try\s+again)\s+in\s+(\d+(?:\.\d+)?)s\b/i.exec(message);
  if (!hint) return Math.min(12_000, exponentialMs);
  const seconds = Number(hint[1]);
  if (!Number.isFinite(seconds)) return Math.min(12_000, exponentialMs);
  return Math.max(exponentialMs, Math.min(12_000, Math.ceil(seconds * 1000) + 250));
}

/** Permanent errors that should fail fast without retrying. */
export function isPermanentError(err: unknown): boolean {
  if (!err) return false;
  const status = (err as any)?.status ?? (err as any)?.statusCode ?? (err as any)?.response?.status;
  if (status === 400 || status === 401 || status === 403 || status === 404) return true;
  const message = err instanceof Error ? err.message : String(err);
  if (/\b(?:400|401|403|404)\b/.test(message)) return true;
  if (/unauthorized|forbidden|not found/i.test(message) && !/429/i.test(message)) return true;
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
  let primaryRetried = false;

  for (let a = 0; a < agents.length; a++) {
    const agent = agents[a]!;
    // Avoid double retry stacking: if primary already retried, fallback gets 0 retries
    const maxRetries = a > 0 && primaryRetried ? 0 : o.retries;

    for (let i = 0; i <= maxRetries; i++) {
      if (o.isCancelled()) throw new CancelledError();
      try {
        return await o.attempt(agent);
      } catch (e) {
        lastErr = e;
        if (o.isCancelled()) throw new CancelledError();
        if (o.canRetry && !o.canRetry()) throw new ForgeFailure('The run stopped after an approved operation; automatic replay was skipped.');

        if (a === 0 && i > 0) primaryRetried = true;

        // Fail fast on permanent errors: do not retry them before falling back or failing
        if (isPermanentError(e)) {
          break;
        }

        if (i < maxRetries) {
          if (a === 0) primaryRetried = true;
          o.onRetry?.(agent, i + 1, e);
          await o.sleep(retryDelay(e, o.backoffMs * 2 ** i));
        }
      }
    }
    if (a === 0 && agents.length > 1) o.onFallback?.(lastErr);
  }
  throw new ForgeFailure(agents.length > 1
    ? `Both the primary and fallback models failed (${briefReason(lastErr)}).`
    : `The model request failed (${briefReason(lastErr)}).`);
}
