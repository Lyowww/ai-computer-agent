import { createHash } from "node:crypto";
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
  return ComputerActionSchema.parse(raw) as ComputerAction;
}

/**
 * Soft-parse an action; returns null instead of throwing.
 */
export function tryParseAction(raw: unknown): ComputerAction | null {
  const result = ComputerActionSchema.safeParse(raw);
  return result.success ? (result.data as ComputerAction) : null;
}

function normalizeKeyToken(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/^control$/, "ctrl")
    .replace(/^cmd$/, "meta")
    .replace(/^command$/, "meta")
    .replace(/^option$/, "alt")
    .replace(/^return$/, "enter");
}

/** Short stable hash for TYPE_TEXT fingerprints (avoids storing plaintext). */
export function hashTextFingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * Deterministic action fingerprint for loop detection.
 * Examples: CLICK:500:300:left | TYPE_TEXT:<hash> | HOTKEY:ctrl+l
 */
export function actionFingerprint(action: ComputerAction): string {
  switch (action.type) {
    case "CLICK":
    case "DOUBLE_CLICK": {
      const button = normalizeKeyToken(action.params.button ?? "LEFT");
      return `${action.type}:${action.params.x}:${action.params.y}:${button}`;
    }
    case "MOVE_MOUSE":
      return `${action.type}:${action.params.x}:${action.params.y}`;
    case "TYPE_TEXT":
      return `TYPE_TEXT:${hashTextFingerprint(action.params.text)}`;
    case "KEY_PRESS":
      return `KEY_PRESS:${normalizeKeyToken(action.params.key)}`;
    case "HOTKEY":
      return `HOTKEY:${action.params.keys.map(normalizeKeyToken).join("+")}`;
    case "OPEN_APP":
      return `OPEN_APP:${action.params.app.trim().toLowerCase()}`;
    case "WAIT":
      return `WAIT:${action.params.ms}`;
    case "SCREENSHOT":
      return `SCREENSHOT:${action.params.reason ?? ""}`;
    case "DONE":
      return `DONE:${action.params.summary ?? ""}`;
    case "ASK_USER":
      return `ASK_USER:${hashTextFingerprint(action.params.question)}`;
    default: {
      const _exhaustive: never = action;
      return String(_exhaustive);
    }
  }
}

export function validateActionParams(
  type: ActionType,
  params: unknown,
): ComputerAction {
  const schema = PARAM_SCHEMAS[type];
  const parsed = schema.parse(params);
  return { type, params: parsed } as ComputerAction;
}
