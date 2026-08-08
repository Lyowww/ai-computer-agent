import type {
  AiChatMessage,
  AiCompletionRequest,
  AiCompletionResponse,
  AiMessageContent,
  AiProvider,
} from "../../types/index.js";
import {
  ProviderError,
  fetchWithTimeout,
  mapHttpStatusToProviderError,
  sanitizeProviderErrorText,
  withRetries,
} from "../errors.js";

export interface OpenRouterConfig {
  apiKey: string;
  baseUrl?: string;
  /** Optional HTTP-Referer header for OpenRouter rankings. */
  siteUrl?: string;
  /** Optional X-Title header for OpenRouter rankings. */
  siteName?: string;
  fetchImpl?: typeof fetch;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Max attempts for retryable failures (429 / 5xx / network). */
  maxRetries?: number;
}

interface OpenAIStyleMessage {
  role: "system" | "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
}

function toOpenAIContent(
  content: string | AiMessageContent[],
): OpenAIStyleMessage["content"] {
  if (typeof content === "string") {
    return content;
  }

  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text" as const, text: part.text };
    }
    return {
      type: "image_url" as const,
      image_url: { url: part.url },
    };
  });
}

function toOpenAIMessages(messages: AiChatMessage[]): OpenAIStyleMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: toOpenAIContent(m.content),
  }));
}

function extractErrorMessage(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "unknown error";
  const obj = raw as {
    error?: { message?: string } | string;
    message?: string;
  };
  if (typeof obj.error === "string") return obj.error;
  if (obj.error && typeof obj.error === "object" && obj.error.message) {
    return obj.error.message;
  }
  if (typeof obj.message === "string") return obj.message;
  try {
    return JSON.stringify(raw);
  } catch {
    return "unknown error";
  }
}

/**
 * OpenRouter provider — OpenAI-compatible chat completions with vision.
 * https://openrouter.ai/docs
 */
export class OpenRouterProvider implements AiProvider {
  readonly name = "openrouter" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly siteUrl?: string;
  private readonly siteName?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: OpenRouterConfig) {
    if (!config.apiKey) {
      throw new ProviderError({
        code: "MISSING_API_KEY",
        message: "OPENROUTER_API_KEY is required for OpenRouterProvider",
        provider: "openrouter",
        retryable: false,
      });
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://openrouter.ai/api/v1").replace(
      /\/$/,
      "",
    );
    this.siteUrl = config.siteUrl;
    this.siteName = config.siteName;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.maxRetries = config.maxRetries ?? 3;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    return withRetries((attempt) => this.completeOnce(request, attempt), {
      maxAttempts: this.maxRetries,
      baseDelayMs: 500,
    });
  }

  private async completeOnce(
    request: AiCompletionRequest,
    _attempt: number,
  ): Promise<AiCompletionResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.siteUrl) headers["HTTP-Referer"] = this.siteUrl;
    if (this.siteName) headers["X-Title"] = this.siteName;

    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAIMessages(request.messages),
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? 2048,
    };

    if (request.responseFormat === "json_object") {
      body.response_format = { type: "json_object" };
    }

    let res: Response;
    try {
      res = await fetchWithTimeout(
        this.fetchImpl,
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        },
        this.timeoutMs,
        "openrouter",
      );
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError({
        code: "NETWORK",
        message: `OpenRouter network error: ${
          err instanceof Error
            ? sanitizeProviderErrorText(err.message)
            : "unknown"
        }`,
        provider: "openrouter",
        retryable: true,
        cause: err,
      });
    }

    let raw: unknown;
    try {
      raw = await res.json();
    } catch (err) {
      throw new ProviderError({
        code: "MALFORMED_RESPONSE",
        message: "OpenRouter returned a non-JSON response body",
        provider: "openrouter",
        status: res.status,
        retryable: res.status >= 500,
        cause: err,
      });
    }

    if (!res.ok) {
      throw mapHttpStatusToProviderError(
        "openrouter",
        res.status,
        extractErrorMessage(raw),
      );
    }

    const choices = (raw as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ProviderError({
        code: "MALFORMED_RESPONSE",
        message: "OpenRouter returned no completion choices",
        provider: "openrouter",
        retryable: false,
      });
    }

    const content = (
      choices[0] as { message?: { content?: string | null } }
    )?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new ProviderError({
        code: "MALFORMED_RESPONSE",
        message: "OpenRouter returned empty completion content",
        provider: "openrouter",
        retryable: false,
      });
    }

    const usage = (raw as { usage?: Record<string, number>; model?: string })
      .usage;

    return {
      content,
      model: String(
        (raw as { model?: string }).model ?? request.model,
      ),
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          }
        : undefined,
      raw,
    };
  }
}
