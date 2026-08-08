import type {
  AiChatMessage,
  AiMessageContent,
  AiProvider,
  Screenshot,
} from "../types/index.js";
import { toImageDataUrl, extractJsonObject } from "../utils/index.js";
import { buildSystemPrompt, buildUserPrompt } from "../prompts/index.js";
import {
  AiPlanResponseSchema,
  normalizeRawPlan,
} from "../schemas/index.js";
import type { ParsedAiPlanResponse } from "../schemas/index.js";
import type { ClassifiedIntent } from "../intent/index.js";

function visionBoundaryLog(
  stage: string,
  extra?: Record<string, unknown>,
): void {
  console.log(
    JSON.stringify({
      level: "INFO",
      stage,
      ...extra,
    }),
  );
}

export interface VisionPlanRequest {
  provider: AiProvider;
  model: string;
  screenshot: Screenshot;
  historySummary: string;
  iteration: number;
  maxIterations: number;
  userReply?: string;
  temperature?: number;
  /** Pre-classified intent — locks action type in the prompt. */
  intent?: ClassifiedIntent;
}

/**
 * Call a vision-capable model with screenshot + task context and
 * parse a structured plan response.
 */
export async function planWithVision(
  request: VisionPlanRequest,
): Promise<ParsedAiPlanResponse> {
  const system = buildSystemPrompt(request.intent);
  const userText = buildUserPrompt({
    historySummary: request.historySummary,
    screenshotWidth: request.screenshot.width,
    screenshotHeight: request.screenshot.height,
    userReply: request.userReply,
    maxIterations: request.maxIterations,
    iteration: request.iteration,
    intent: request.intent,
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

  visionBoundaryLog("RAW_MODEL_RESPONSE", {
    raw: parsed,
  });

  // Normalize harmless optional human-readable fields BEFORE Zod.
  // Never invents actions — genuinely invalid plans still fail validation.
  const normalized = normalizeRawPlan(parsed);
  visionBoundaryLog("NORMALIZED_RESPONSE", {
    normalized,
  });

  const validated = AiPlanResponseSchema.safeParse(normalized);
  if (!validated.success) {
    throw new Error(
      `Vision model response failed schema validation: ${validated.error.message}`,
    );
  }

  visionBoundaryLog("VALIDATED_RESPONSE", {
    status: validated.data.status,
    reasoning_summary: validated.data.reasoning_summary,
    message: validated.data.message,
    actions: validated.data.actions.map((a) => ({
      type: a.type,
      params: a.params,
    })),
  });

  return validated.data;
}
