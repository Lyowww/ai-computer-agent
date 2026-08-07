import type {
  AiChatMessage,
  AiCompletionRequest,
  AiCompletionResponse,
  AiMessageContent,
  AiProvider,
} from "../../types/index.js";

export interface OpenRouterConfig {
  apiKey: string;
  baseUrl?: string;
  /** Optional HTTP-Referer / X-Title headers for OpenRouter rankings. */
  siteUrl?: string;
  siteName?: string;
  fetchImpl?: typeof fetch;
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

  constructor(config: OpenRouterConfig) {
    if (!config.apiKey) {
      throw new Error("OPENROUTER_API_KEY is required for OpenRouterProvider");
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://openrouter.ai/api/v1").replace(
      /\/$/,
      "",
    );
    this.siteUrl = config.siteUrl;
    this.siteName = config.siteName;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
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

    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const raw = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      const errMsg =
        (raw as { error?: { message?: string } })?.error?.message ??
        JSON.stringify(raw);
      throw new Error(`OpenRouter API error (${res.status}): ${errMsg}`);
    }

    const choices = raw.choices as
      | Array<{ message?: { content?: string | null } }>
      | undefined;
    const content = choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error("OpenRouter returned empty completion content");
    }

    const usage = raw.usage as
      | {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        }
      | undefined;

    return {
      content,
      model: String(raw.model ?? request.model),
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
