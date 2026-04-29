export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULT_OPTS: Required<Omit<RetryOptions, "shouldRetry" | "onRetry">> = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 8000,
  jitter: true,
};

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const merged = { ...DEFAULT_OPTS, ...opts };
  let lastError: unknown;
  for (let attempt = 1; attempt <= merged.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt === merged.maxAttempts) break;
      if (opts.shouldRetry && !opts.shouldRetry(e, attempt)) break;
      const exp = Math.min(
        merged.initialDelayMs * 2 ** (attempt - 1),
        merged.maxDelayMs,
      );
      // Full jitter (Math.random() * exp) avoids thundering-herd retry clustering
      // when multiple parallel jobs hit the same 429 simultaneously.
      const delay = merged.jitter ? Math.random() * exp : exp;
      opts.onRetry?.(e, attempt, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const o = err as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  };
  return o.status ?? o.statusCode ?? o.response?.status;
}

export function isTransientHttpError(err: unknown): boolean {
  const status = extractStatus(err);
  if (typeof status === "number") {
    return status === 429 || status === 503 || (status >= 500 && status < 600);
  }
  const msg = (err && typeof err === "object" && "message" in err
    ? String((err as { message: unknown }).message)
    : "");
  return /ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|ECONNREFUSED|ENOTFOUND|socket hang up|UND_ERR_/i.test(
    msg,
  );
}

/**
 * Permanent failures that should abort retries immediately:
 *   - 401/403: auth revoked or forbidden (won't recover)
 *   - 404: resource gone
 *   - 410: gone (deprecated)
 *   - 451: legal block
 */
export function isFatalHttpError(err: unknown): boolean {
  const status = extractStatus(err);
  if (typeof status !== "number") return false;
  return [401, 403, 404, 410, 451].includes(status);
}
