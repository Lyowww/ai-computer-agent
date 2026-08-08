import type {
  AiChatMessage,
  AiMessageContent,
  AiProvider,
  Screenshot,
} from "../types/index.js";
import { toImageDataUrl, extractJsonObject } from "../utils/index.js";
import { buildSystemPrompt, buildUserPrompt } from "../prompts/index.js";
import { AiPlanResponseSchema } from "../schemas/index.js";
import type { ParsedAiPlanResponse } from "../schemas/index.js";

export interface VisionPlanRequest {
  provider: AiProvider;
  model: string;
  screenshot: Screenshot;
  historySummary: string;
  iteration: number;
  maxIterations: number;
  userReply?: string;
  temperature?: number;
}

/**
 * Call a vision-capable model with screenshot + task context and
 * parse a structured plan response.
 */
export async function planWithVision(
  request: VisionPlanRequest,
): Promise<ParsedAiPlanResponse> {
  const system = buildSystemPrompt();
  const userText = buildUserPrompt({
    historySummary: request.historySummary,
    screenshotWidth: request.screenshot.width,
    screenshotHeight: request.screenshot.height,
    userReply: request.userReply,
    maxIterations: request.maxIterations,
    iteration: request.iteration,
  });

  const imageUrl = toImageDataUrl(request.screenshot);

  // Screenshot must be sent as an image part — never as plain text.
  const userContent: AiMessageContent[] = [
    { type: "text", text: userText },
    { type: "image", url: imageUrl },
  ];

  const messages: AiChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: userContent },
  ];

  const completion = await request.provider.complete({
    model: request.model,
    messages,
    temperature: request.temperature ?? 0.2,
    maxTokens: 2048,
    responseFormat: "json_object",
  });

  let parsed: unknown;
  try {
    parsed = extractJsonObject(completion.content);
  } catch (err) {
    throw new Error(
      `Vision model returned non-JSON content: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const validated = AiPlanResponseSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `Vision model response failed schema validation: ${validated.error.message}`,
    );
  }

  return validated.data;
}
