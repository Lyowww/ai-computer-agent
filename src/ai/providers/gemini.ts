import type {
  AiChatMessage,
  AiCompletionRequest,
  AiCompletionResponse,
  AiMessageContent,
  AiProvider,
} from "../../types/index.js";

export interface GeminiConfig {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
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
    throw new Error(
      "Gemini provider requires data-URL or base64 images (HTTPS image URLs are not supported here)",
    );
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
    throw new Error(
      "Gemini provider requires data-URL images; remote HTTPS image URLs are unsupported",
    );
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

/**
 * Google Gemini provider via the Generative Language API (v1beta).
 * https://ai.google.dev/api/generate-content
 */
export class GeminiProvider implements AiProvider {
  readonly name = "gemini" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: GeminiConfig) {
    if (!config.apiKey) {
      throw new Error("GEMINI_API_KEY is required for GeminiProvider");
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (
      config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
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

    const url = `${this.baseUrl}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const raw = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      const errMsg =
        (raw as { error?: { message?: string } })?.error?.message ??
        JSON.stringify(raw);
      throw new Error(`Gemini API error (${res.status}): ${errMsg}`);
    }

    const candidates = raw.candidates as
      | Array<{ content?: { parts?: Array<{ text?: string }> } }>
      | undefined;
    const parts = candidates?.[0]?.content?.parts ?? [];
    const content = parts
      .map((p) => p.text ?? "")
      .join("")
      .trim();

    if (!content) {
      throw new Error("Gemini returned empty completion content");
    }

    const usageMeta = raw.usageMetadata as
      | {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
        }
      | undefined;

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
