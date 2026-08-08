/**
 * Application-level AI provider errors.
 * Never include API keys or Authorization headers in messages.
 */

export type ProviderErrorCode =
  | "MISSING_API_KEY"
  | "INVALID_API_KEY"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "TIMEOUT"
  | "NETWORK"
  | "MALFORMED_RESPONSE"
  | "MODEL_UNAVAILABLE"
  | "VISION_UNSUPPORTED"
  | "INVALID_REQUEST"
  | "UNKNOWN";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(options: {
    code: ProviderErrorCode;
    message: string;
    provider: string;
    status?: number;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(
      options.message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "ProviderError";
    this.code = options.code;
    this.provider = options.provider;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

/** Strip secrets that might appear in provider error payloads. */
export function sanitizeProviderErrorText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
    .replace(/key=[^&\s"']+/gi, "key=[REDACTED]")
    .replace(/sk-or-v1-[A-Za-z0-9]+/gi, "[REDACTED]")
    .replace(/AIza[A-Za-z0-9_\-]+/gi, "[REDACTED]");
}

export function mapHttpStatusToProviderError(
  provider: string,
  status: number,
  bodyMessage: string,
): ProviderError {
  const message = sanitizeProviderErrorText(bodyMessage);
  if (status === 401) {
    return new ProviderError({
      code: "UNAUTHORIZED",
      message: `${provider} authentication failed (401): ${message || "invalid API key"}`,
      provider,
      status,
      retryable: false,
    });
  }
  if (status === 403) {
    return new ProviderError({
      code: "FORBIDDEN",
      message: `${provider} request forbidden (403): ${message}`,
      provider,
      status,
      retryable: false,
    });
  }
  if (status === 404) {
    return new ProviderError({
      code: "MODEL_UNAVAILABLE",
      message: `${provider} model or endpoint unavailable (404): ${message}`,
      provider,
      status,
      retryable: false,
    });
  }
  if (status === 408 || status === 504) {
    return new ProviderError({
      code: "TIMEOUT",
      message: `${provider} request timed out (${status}): ${message}`,
      provider,
      status,
      retryable: true,
    });
  }
  if (status === 429) {
    return new ProviderError({
      code: "RATE_LIMITED",
      message: `${provider} rate limit exceeded (429): ${message}`,
      provider,
      status,
      retryable: true,
    });
  }
  if (status >= 500) {
    return new ProviderError({
      code: "SERVER_ERROR",
      message: `${provider} server error (${status}): ${message}`,
      provider,
      status,
      retryable: true,
    });
  }
  if (status === 400) {
    const lower = message.toLowerCase();
    const vision =
      lower.includes("vision") ||
      lower.includes("image") ||
      lower.includes("multimodal");
    return new ProviderError({
      code: vision ? "VISION_UNSUPPORTED" : "INVALID_REQUEST",
      message: `${provider} invalid request (400): ${message}`,
      provider,
      status,
      retryable: false,
    });
  }
  return new ProviderError({
    code: "UNKNOWN",
    message: `${provider} API error (${status}): ${message}`,
    provider,
    status,
    retryable: false,
  });
}

export function isRetryableProviderError(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable;
  if (err instanceof Error) {
    const name = err.name.toLowerCase();
    const msg = err.message.toLowerCase();
    if (
      name === "aborterror" ||
      msg.includes("aborted") ||
      msg.includes("timeout")
    ) {
      return true;
    }
    if (
      msg.includes("fetch failed") ||
      msg.includes("network") ||
      msg.includes("econnreset")
    ) {
      return true;
    }
  }
  return false;
}

export async function withRetries<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    maxAttempts: number;
    baseDelayMs?: number;
    shouldRetry?: (err: unknown, attempt: number) => boolean;
  },
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts);
  const baseDelayMs = options.baseDelayMs ?? 400;
  const shouldRetry = options.shouldRetry ?? isRetryableProviderError;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !shouldRetry(err, attempt)) {
        throw err;
      }
      const delay = baseDelayMs * 2 ** (attempt - 1);
      await sleep(delay);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  provider: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "AbortError" ||
        err.message.toLowerCase().includes("aborted"))
    ) {
      throw new ProviderError({
        code: "TIMEOUT",
        message: `${provider} request timed out after ${timeoutMs}ms`,
        provider,
        retryable: true,
        cause: err,
      });
    }
    throw new ProviderError({
      code: "NETWORK",
      message: `${provider} network error: ${
        err instanceof Error
          ? sanitizeProviderErrorText(err.message)
          : "unknown"
      }`,
      provider,
      retryable: true,
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
}
