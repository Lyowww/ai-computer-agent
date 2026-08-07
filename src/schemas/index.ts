import { z } from "zod";

export const MouseButtonSchema = z.enum(["LEFT", "RIGHT", "MIDDLE"]);

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

export const ComputerActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("CLICK"), params: ClickParamsSchema }),
  z.object({ type: z.literal("DOUBLE_CLICK"), params: DoubleClickParamsSchema }),
  z.object({ type: z.literal("MOVE_MOUSE"), params: MoveMouseParamsSchema }),
  z.object({ type: z.literal("TYPE_TEXT"), params: TypeTextParamsSchema }),
  z.object({ type: z.literal("KEY_PRESS"), params: KeyPressParamsSchema }),
  z.object({ type: z.literal("HOTKEY"), params: HotkeyParamsSchema }),
  z.object({ type: z.literal("OPEN_APP"), params: OpenAppParamsSchema }),
  z.object({ type: z.literal("WAIT"), params: WaitParamsSchema }),
  z.object({ type: z.literal("SCREENSHOT"), params: ScreenshotParamsSchema }),
  z.object({ type: z.literal("DONE"), params: DoneParamsSchema }),
  z.object({ type: z.literal("ASK_USER"), params: AskUserParamsSchema }),
]);

export const AgentStatusSchema = z.enum([
  "ACTION_REQUIRED",
  "COMPLETED",
  "NEEDS_USER_INPUT",
  "FAILED",
]);

export const AiPlanResponseSchema = z.object({
  status: AgentStatusSchema,
  reasoning_summary: z.string().min(1).max(1000),
  actions: z.array(ComputerActionSchema).max(10),
  message: z.string().min(1).max(4000),
});

export const ScreenshotSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  image: z.string().min(1),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]).optional(),
});

export type ParsedComputerAction = z.infer<typeof ComputerActionSchema>;
export type ParsedAiPlanResponse = z.infer<typeof AiPlanResponseSchema>;
export type ParsedScreenshot = z.infer<typeof ScreenshotSchema>;
