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
      const delay = merged.jitter ? exp * (0.5 + Math.random() * 0.5) : exp;
      opts.onRetry?.(e, attempt, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

export function isTransientHttpError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: number; statusCode?: number; response?: { status?: number } }).status
    ?? (err as { statusCode?: number }).statusCode
    ?? (err as { response?: { status?: number } }).response?.status;
  if (typeof status === "number") {
    return status === 429 || status === 503 || (status >= 500 && status < 600);
  }
  const msg = (err as { message?: string }).message ?? "";
  return /ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN/.test(msg);
}
