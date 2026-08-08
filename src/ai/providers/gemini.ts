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

export interface GeminiConfig {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

function parseDataUrl(url: string): { mimeType: string; data: string } {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
  if (!match) {
    throw new ProviderError({
      code: "VISION_UNSUPPORTED",
      message:
        "Gemini provider requires data-URL or base64 images (HTTPS image URLs are not supported)",
      provider: "gemini",
      retryable: false,
    });
  }
  return { mimeType: match[1], data: match[2] };
}

function contentToParts(content: string | AiMessageContent[]): GeminiPart[] {
  if (typeof content === "string") {
    return [{ text: content }];
  }

  return content.map((part) => {
    if (part.type === "text") {
      return { text: part.text };
    }
    if (part.url.startsWith("data:")) {
      const { mimeType, data } = parseDataUrl(part.url);
      return { inlineData: { mimeType, data } };
    }
    throw new ProviderError({
      code: "VISION_UNSUPPORTED",
      message:
        "Gemini provider requires data-URL images; remote HTTPS image URLs are unsupported",
      provider: "gemini",
      retryable: false,
    });
  });
}

/**
 * Convert OpenAI-style messages into Gemini generateContent payload.
 * System messages are folded into systemInstruction.
 */
function toGeminiPayload(messages: AiChatMessage[]): {
  systemInstruction?: { parts: GeminiPart[] };
  contents: GeminiContent[];
} {
  const systemParts: GeminiPart[] = [];
  const contents: GeminiContent[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(...contentToParts(msg.content));
      continue;
    }
    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: contentToParts(msg.content),
    });
  }

  return {
    systemInstruction:
      systemParts.length > 0 ? { parts: systemParts } : undefined,
    contents,
  };
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
 * Google Gemini provider via the Generative Language API (v1beta).
 * https://ai.google.dev/api/generate-content
 */
export class GeminiProvider implements AiProvider {
  readonly name = "gemini" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: GeminiConfig) {
    if (!config.apiKey) {
      throw new ProviderError({
        code: "MISSING_API_KEY",
        message: "GEMINI_API_KEY is required for GeminiProvider",
        provider: "gemini",
        retryable: false,
      });
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (
      config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/$/, "");
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
    const { systemInstruction, contents } = toGeminiPayload(request.messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: request.temperature ?? 0.2,
        maxOutputTokens: request.maxTokens ?? 2048,
        ...(request.responseFormat === "json_object"
          ? { responseMimeType: "application/json" }
          : {}),
      },
    };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    // Keep API key out of logged URLs — only used for the request itself.
    const url = `${this.baseUrl}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    let res: Response;
    try {
      res = await fetchWithTimeout(
        this.fetchImpl,
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        this.timeoutMs,
        "gemini",
      );
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError({
        code: "NETWORK",
        message: `Gemini network error: ${
          err instanceof Error
            ? sanitizeProviderErrorText(err.message)
            : "unknown"
        }`,
        provider: "gemini",
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
        message: "Gemini returned a non-JSON response body",
        provider: "gemini",
        status: res.status,
        retryable: res.status >= 500,
        cause: err,
      });
    }

    if (!res.ok) {
      throw mapHttpStatusToProviderError(
        "gemini",
        res.status,
        extractErrorMessage(raw),
      );
    }

    const candidates = (raw as { candidates?: unknown }).candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new ProviderError({
        code: "MALFORMED_RESPONSE",
        message: "Gemini returned no candidates",
        provider: "gemini",
        retryable: false,
      });
    }

    const parts =
      (
        candidates[0] as {
          content?: { parts?: Array<{ text?: string }> };
        }
      )?.content?.parts ?? [];
    const content = parts
      .map((p) => p.text ?? "")
      .join("")
      .trim();

    if (!content) {
      throw new ProviderError({
        code: "MALFORMED_RESPONSE",
        message: "Gemini returned empty completion content",
        provider: "gemini",
        retryable: false,
      });
    }

    const usageMeta = (
      raw as {
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
        };
      }
    ).usageMetadata;

    return {
      content,
      model: request.model,
      usage: usageMeta
        ? {
            promptTokens: usageMeta.promptTokenCount,
            completionTokens: usageMeta.candidatesTokenCount,
            totalTokens: usageMeta.totalTokenCount,
          }
        : undefined,
      raw,
    };
  }
}
