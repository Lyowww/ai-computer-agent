import type { ComputerAction, ActionType } from "../types/index.js";
import {
  ClickParamsSchema,
  DoubleClickParamsSchema,
  MoveMouseParamsSchema,
  TypeTextParamsSchema,
  KeyPressParamsSchema,
  HotkeyParamsSchema,
  OpenAppParamsSchema,
  WaitParamsSchema,
  ScreenshotParamsSchema,
  DoneParamsSchema,
  AskUserParamsSchema,
  ComputerActionSchema,
} from "../schemas/index.js";

export const SUPPORTED_ACTIONS: readonly ActionType[] = [
  "CLICK",
  "DOUBLE_CLICK",
  "MOVE_MOUSE",
  "TYPE_TEXT",
  "KEY_PRESS",
  "HOTKEY",
  "OPEN_APP",
  "WAIT",
  "SCREENSHOT",
  "DONE",
  "ASK_USER",
] as const;

const PARAM_SCHEMAS = {
  CLICK: ClickParamsSchema,
  DOUBLE_CLICK: DoubleClickParamsSchema,
  MOVE_MOUSE: MoveMouseParamsSchema,
  TYPE_TEXT: TypeTextParamsSchema,
  KEY_PRESS: KeyPressParamsSchema,
  HOTKEY: HotkeyParamsSchema,
  OPEN_APP: OpenAppParamsSchema,
  WAIT: WaitParamsSchema,
  SCREENSHOT: ScreenshotParamsSchema,
  DONE: DoneParamsSchema,
  ASK_USER: AskUserParamsSchema,
} as const;

export function isSupportedActionType(type: string): type is ActionType {
  return (SUPPORTED_ACTIONS as readonly string[]).includes(type);
}

/**
 * Parse and validate a single computer action.
 * Throws ZodError on invalid shape.
 */
export function parseAction(raw: unknown): ComputerAction {
  return ComputerActionSchema.parse(raw);
}

/**
 * Soft-parse an action; returns null instead of throwing.
 */
export function tryParseAction(raw: unknown): ComputerAction | null {
  const result = ComputerActionSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function actionFingerprint(action: ComputerAction): string {
  return `${action.type}:${stableStringify(action.params)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function validateActionParams(
  type: ActionType,
  params: unknown,
): ComputerAction {
  const schema = PARAM_SCHEMAS[type];
  const parsed = schema.parse(params);
  return { type, params: parsed } as ComputerAction;
}
