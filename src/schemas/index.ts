import { z } from "zod";

const MouseButtonSchema = z.preprocess((value) => {
  if (typeof value === "string") return value.trim().toUpperCase();
  return value;
}, z.enum(["LEFT", "RIGHT", "MIDDLE"]));

export const ClickParamsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  button: MouseButtonSchema.optional().default("LEFT"),
});

export const DoubleClickParamsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  button: MouseButtonSchema.optional().default("LEFT"),
});

export const MoveMouseParamsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const TypeTextParamsSchema = z.object({
  text: z.string().min(1).max(10_000),
});

export const KeyPressParamsSchema = z.object({
  key: z.string().min(1).max(64),
});

export const HotkeyParamsSchema = z.object({
  keys: z.array(z.string().min(1).max(64)).min(1).max(6),
});

export const OpenAppParamsSchema = z.object({
  app: z.string().min(1).max(256),
});

export const WaitParamsSchema = z.object({
  ms: z.number().int().min(0).max(60_000),
});

export const ScreenshotParamsSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const DoneParamsSchema = z.object({
  summary: z.string().max(2000).optional(),
});

export const AskUserParamsSchema = z.object({
  question: z.string().min(1).max(2000),
  reason: z.string().max(1000).optional(),
});

const ACTION_PARAM_KEYS: Record<string, readonly string[]> = {
  CLICK: ["x", "y", "button"],
  DOUBLE_CLICK: ["x", "y", "button"],
  MOVE_MOUSE: ["x", "y"],
  TYPE_TEXT: ["text"],
  KEY_PRESS: ["key"],
  HOTKEY: ["keys"],
  OPEN_APP: ["app"],
  WAIT: ["ms"],
  SCREENSHOT: ["reason"],
  DONE: ["summary"],
  ASK_USER: ["question", "reason"],
};

/**
 * Normalize model output that may use flat action fields
 * (`{ type: "CLICK", x: 1, y: 2 }`) into the canonical `{ type, params }` shape.
 */
export function normalizeRawAction(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  const type = obj.type;
  if (typeof type !== "string") return raw;

  if (
    obj.params !== undefined &&
    typeof obj.params === "object" &&
    obj.params !== null &&
    !Array.isArray(obj.params)
  ) {
    return { type, params: obj.params };
  }

  const allowed = ACTION_PARAM_KEYS[type];
  if (!allowed) {
    // Unknown type — leave as-is so Zod rejects it cleanly.
    return raw;
  }

  const params: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in obj && obj[key] !== undefined) {
      params[key] = obj[key];
    }
  }
  return { type, params };
}

export function normalizeRawPlan(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.actions)) return raw;
  return {
    ...obj,
    actions: obj.actions.map(normalizeRawAction),
  };
}

export const ComputerActionSchema = z.preprocess(
  normalizeRawAction,
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("CLICK"), params: ClickParamsSchema }),
    z.object({
      type: z.literal("DOUBLE_CLICK"),
      params: DoubleClickParamsSchema,
    }),
    z.object({ type: z.literal("MOVE_MOUSE"), params: MoveMouseParamsSchema }),
    z.object({ type: z.literal("TYPE_TEXT"), params: TypeTextParamsSchema }),
    z.object({ type: z.literal("KEY_PRESS"), params: KeyPressParamsSchema }),
    z.object({ type: z.literal("HOTKEY"), params: HotkeyParamsSchema }),
    z.object({ type: z.literal("OPEN_APP"), params: OpenAppParamsSchema }),
    z.object({ type: z.literal("WAIT"), params: WaitParamsSchema }),
    z.object({
      type: z.literal("SCREENSHOT"),
      params: ScreenshotParamsSchema,
    }),
    z.object({ type: z.literal("DONE"), params: DoneParamsSchema }),
    z.object({ type: z.literal("ASK_USER"), params: AskUserParamsSchema }),
  ]),
);

export const AgentStatusSchema = z.enum([
  "ACTION_REQUIRED",
  "COMPLETED",
  "NEEDS_USER_INPUT",
  "FAILED",
]);

export const AiPlanResponseSchema = z.preprocess(
  normalizeRawPlan,
  z.object({
    status: AgentStatusSchema,
    reasoning_summary: z.string().min(1).max(1000),
    actions: z.array(ComputerActionSchema).max(10),
    message: z.string().min(1).max(4000),
  }),
);

export const ScreenshotSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  image: z.string().min(1),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]).optional(),
});

export type ParsedComputerAction = z.infer<typeof ComputerActionSchema>;
export type ParsedAiPlanResponse = z.infer<typeof AiPlanResponseSchema>;
export type ParsedScreenshot = z.infer<typeof ScreenshotSchema>;

// Re-export for callers that imported MouseButtonSchema previously
export { MouseButtonSchema };
