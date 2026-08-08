import { z } from "zod";

const MouseButtonSchema = z.preprocess((value) => {
  if (typeof value === "string") return value.trim().toUpperCase();
  return value;
}, z.enum(["LEFT", "RIGHT", "MIDDLE"]));

/** Optional UI label for validation/debug — never treated as proof of correct coords. */
const TargetLabelSchema = z.string().min(1).max(128).optional();
const TargetConfidenceSchema = z.number().min(0).max(1).optional();
const TargetSourceSchema = z.string().min(1).max(64).optional();

export const ClickParamsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  button: MouseButtonSchema.optional().default("LEFT"),
  targetLabel: TargetLabelSchema,
  targetConfidence: TargetConfidenceSchema,
  targetSource: TargetSourceSchema,
});

export const DoubleClickParamsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  button: MouseButtonSchema.optional().default("LEFT"),
  targetLabel: TargetLabelSchema,
  targetConfidence: TargetConfidenceSchema,
  targetSource: TargetSourceSchema,
});

export const MoveMouseParamsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  targetLabel: TargetLabelSchema,
});

export const ScrollDirectionSchema = z.preprocess((value) => {
  if (typeof value === "string") return value.trim().toLowerCase();
  return value;
}, z.enum(["up", "down", "left", "right"]));

/**
 * Natural-language amount tokens → numeric wheel notches (nut.js ticks).
 * Unknown strings are NOT mapped — Zod rejects them.
 */
export const SCROLL_AMOUNT_ALIASES: Readonly<Record<string, number>> = {
  tiny: 1,
  small: 2,
  little: 2,
  medium: 5,
  normal: 5,
  default: 5,
  large: 15,
  big: 15,
  huge: 25,
  far: 20,
  "a lot": 20,
  alot: 20,
};

/** Amount strings that mean scroll-to-extreme, not a notch count. */
const SCROLL_TO_END_AMOUNT_ALIASES: ReadonlySet<string> = new Set([
  "bottom",
  "top",
  "end",
  "start",
  "beginning",
  "to bottom",
  "to top",
  "to end",
  "to start",
  "to the bottom",
  "to the top",
  "to the end",
  "to the start",
  "all the way",
  "alltheway",
]);

function normalizeScrollAmountToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Coerce model SCROLL params before Zod:
 * - numeric strings ("5") → number
 * - known aliases ("small"/"large") → number
 * - end semantics ("bottom"/"to bottom") → toEnd: true
 * - unknown strings left intact so Zod rejects them
 */
export function normalizeScrollParams(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };

  if (
    obj.to_end === true ||
    obj.scrollToEnd === true ||
    obj.scroll_to_end === true
  ) {
    obj.toEnd = true;
  }
  if (typeof obj.toEnd === "string") {
    const t = obj.toEnd.trim().toLowerCase();
    if (t === "true" || t === "1" || t === "yes") obj.toEnd = true;
    else if (t === "false" || t === "0" || t === "no") obj.toEnd = false;
  }

  if (typeof obj.amount === "string") {
    const token = normalizeScrollAmountToken(obj.amount);
    if (/^\d+(\.\d+)?$/.test(token)) {
      obj.amount = Number(token);
    } else if (SCROLL_TO_END_AMOUNT_ALIASES.has(token)) {
      obj.toEnd = true;
      delete obj.amount;
    } else if (Object.prototype.hasOwnProperty.call(SCROLL_AMOUNT_ALIASES, token)) {
      obj.amount = SCROLL_AMOUNT_ALIASES[token];
    }
    // else leave as string → Zod number check fails
  }

  return obj;
}

export const ScrollParamsSchema = z.preprocess(
  normalizeScrollParams,
  z
    .object({
      direction: ScrollDirectionSchema.default("down"),
      amount: z.number().finite().positive().max(100).optional(),
      toEnd: z.boolean().optional().default(false),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
    })
    .transform((p) => {
      if (p.toEnd) {
        return {
          direction: p.direction,
          toEnd: true,
          ...(p.amount !== undefined ? { amount: p.amount } : {}),
          ...(p.x !== undefined ? { x: p.x } : {}),
          ...(p.y !== undefined ? { y: p.y } : {}),
        };
      }
      return {
        direction: p.direction,
        amount: p.amount ?? 5,
        toEnd: false,
        ...(p.x !== undefined ? { x: p.x } : {}),
        ...(p.y !== undefined ? { y: p.y } : {}),
      };
    }),
);

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
  CLICK: [
    "x",
    "y",
    "button",
    "targetLabel",
    "targetConfidence",
    "targetSource",
  ],
  DOUBLE_CLICK: [
    "x",
    "y",
    "button",
    "targetLabel",
    "targetConfidence",
    "targetSource",
  ],
  MOVE_MOUSE: ["x", "y", "targetLabel"],
  SCROLL: ["direction", "amount", "toEnd", "x", "y"],
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

/**
 * Normalize harmless omissions in model plan JSON before Zod validation.
 *
 * Defaults human-readable fields only (`message`, `reasoning_summary`).
 * Never invents missing `actions` — ACTION_REQUIRED without actions still fails.
 */
export function normalizeRawPlan(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;

  const out: Record<string, unknown> = { ...obj };

  // Harmless omissions — human-readable explanation fields only
  if (out.message === undefined || out.message === null) {
    out.message = "";
  }
  if (out.reasoning_summary === undefined || out.reasoning_summary === null) {
    out.reasoning_summary = "";
  }

  // Do NOT invent actions — only normalize shape when the field is present
  if (Array.isArray(obj.actions)) {
    out.actions = obj.actions.map(normalizeRawAction);
  }

  return out;
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
    z.object({ type: z.literal("SCROLL"), params: ScrollParamsSchema }),
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
    /** Operational note — structured actions are authoritative; empty allowed after normalize. */
    reasoning_summary: z.string().max(1000).default(""),
    actions: z.array(ComputerActionSchema).max(10),
    /** User-facing text — required as a string; omission is normalized to "". */
    message: z.string().max(4000).default(""),
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
