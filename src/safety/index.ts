import type { ComputerAction, Screenshot, UserIntent } from "../types/index.js";
import { isCoordinateInBounds } from "../utils/index.js";
import { requiresCoordinates } from "../actions/index.js";
import {
  checkSpatialSanity,
  extractLikelyTargetLabel,
} from "../localization/spatial.js";

export interface SafetyViolation {
  code: string;
  message: string;
  actionIndex: number;
  /** If true, escalate to ASK_USER instead of failing hard. */
  requiresConfirmation: boolean;
}

export interface SafetyCheckResult {
  ok: boolean;
  violations: SafetyViolation[];
  /** Actions that passed safety (may be a subset). */
  safeActions: ComputerAction[];
  /** When confirmation is required, a suggested ASK_USER action. */
  askUserAction?: ComputerAction;
}

/** Patterns that look like shell / script execution attempts in TYPE_TEXT. */
const SHELL_INJECTION_PATTERNS: RegExp[] = [
  /(?:^|[\s;`])(?:sudo|rm\s+-rf|chmod\s|chown\s|mkfs|dd\s+if=)/i,
  /(?:^|[\s;`])(?:curl|wget|powershell|pwsh|cmd\.exe|bash\s+-c|sh\s+-c|osascript|osascript\s+-e)/i,
  /(?:^|[\s;`])(?:eval\s*\(|Function\s*\(|require\s*\(|import\s*\()/i,
  /(?:^|[\s;`])(?:python(?:3)?\s+-c|node\s+-e|perl\s+-e|ruby\s+-e)/i,
  /(?:^|[\s;`])(?:DROP\s+TABLE|DELETE\s+FROM\s+\w+)/i,
  /(?:tell\s+application\s+|do\s+shell\s+script\s+)/i,
];

/** Apps that must never be opened automatically. */
const BLOCKED_APPS: RegExp[] = [
  /terminal/i,
  /iterm/i,
  /warp/i,
  /kitty/i,
  /alacritty/i,
  /powershell/i,
  /cmd\.exe/i,
  /command\s*prompt/i,
  /windows\s*terminal/i,
  /registry\s*editor/i,
  /regedit/i,
  /disk\s*utility/i,
  /keychain\s*access/i,
  /activity\s*monitor/i,
  /system\s*settings/i,
  /system\s*preferences/i,
];

/** Hotkeys that can be destructive or security-sensitive. */
const DANGEROUS_HOTKEYS: string[][] = [
  ["meta", "q"],
  ["alt", "f4"],
  ["ctrl", "alt", "delete"],
  ["meta", "alt", "escape"],
  ["ctrl", "shift", "escape"],
];

/** Text that strongly suggests consequential / destructive intent. */
const DESTRUCTIVE_TEXT_PATTERNS: RegExp[] = [
  /\b(delete|remove|uninstall|format|wipe|erase)\b.+\b(files?|folders?|disks?|drives?|accounts?|passwords?)\b/i,
  /\b(send|submit|confirm)\b.+\b(payment|purchase|order|transfer|wire)\b/i,
  /\b(change|reset|update)\b.+\b(password|credentials|2fa|mfa)\b/i,
  /\b(shut\s*down|restart|reboot|log\s*out|sign\s*out)\b/i,
  /\b(disable|turn\s*off)\b.+\b(firewall|antivirus|security|encryption)\b/i,
  /\b(install|download)\b.+\b(software|package|exe|dmg|msi)\b/i,
];

const LOCK_SCREEN_APP_HINTS: RegExp[] = [
  /lock\s*screen/i,
  /login\s*window/i,
  /keychain\s*access/i,
];

const MIN_TARGET_CONFIDENCE = 0.75;

function normalizeKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/^control$/, "ctrl")
    .replace(/^cmd$/, "meta")
    .replace(/^command$/, "meta")
    .replace(/^option$/, "alt")
    .replace(/^return$/, "enter");
}

function isDangerousHotkey(keys: string[]): boolean {
  const normalized = keys.map(normalizeKey).sort();
  return DANGEROUS_HOTKEYS.some((danger) => {
    const d = [...danger].map(normalizeKey).sort();
    return (
      d.length === normalized.length &&
      d.every((k, i) => k === normalized[i])
    );
  });
}

function hasCoordinateParams(
  params: object,
): params is { x: number; y: number; targetLabel?: string; targetConfidence?: number } {
  return (
    "x" in params &&
    "y" in params &&
    typeof (params as { x: unknown }).x === "number" &&
    typeof (params as { y: unknown }).y === "number"
  );
}

function labelsMatch(claimed: string, expected: string): boolean {
  const a = claimed.trim().toLowerCase();
  const b = expected.trim().toLowerCase();
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  return false;
}

/**
 * Action Safety Layer.
 * Validates that AI-produced actions stay within the allowed computer-control surface
 * and blocks or escalates destructive / security-sensitive operations.
 */
export function validateActionSafety(
  actions: ComputerAction[],
  screenshot: Screenshot,
  options?: { userInstruction?: string; intent?: UserIntent },
): SafetyCheckResult {
  const violations: SafetyViolation[] = [];
  const safeActions: ComputerAction[] = [];

  const instruction = options?.userInstruction ?? "";
  const intent = options?.intent;
  const instructionNeedsConfirm =
    DESTRUCTIVE_TEXT_PATTERNS.some((re) => re.test(instruction));
  const expectedLabel = instruction
    ? extractLikelyTargetLabel(instruction)
    : null;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    let blocked = false;

    // Coordinate bounds + spatial sanity — only for pointer actions
    if (requiresCoordinates(action.type) && hasCoordinateParams(action.params)) {
      const { x, y } = action.params;
      if (!isCoordinateInBounds(x, y, screenshot.width, screenshot.height)) {
        violations.push({
          code: "COORDINATE_OUT_OF_BOUNDS",
          message: `Coordinate (${x}, ${y}) outside screenshot ${screenshot.width}x${screenshot.height}`,
          actionIndex: i,
          requiresConfirmation: false,
        });
        blocked = true;
      } else if (instruction && intent !== "SCROLL") {
        const spatial = checkSpatialSanity(
          x,
          y,
          screenshot.width,
          screenshot.height,
          instruction,
        );
        if (!spatial.ok) {
          violations.push({
            code: "SPATIAL_CONSTRAINT_VIOLATION",
            message:
              spatial.reason ??
              `Click (${x}, ${y}) contradicts spatial language in the instruction`,
            actionIndex: i,
            requiresConfirmation: true,
          });
          blocked = true;
        }

        const claimed =
          typeof action.params.targetLabel === "string"
            ? action.params.targetLabel.trim()
            : "";

        if (
          expectedLabel &&
          (action.type === "CLICK" || action.type === "DOUBLE_CLICK")
        ) {
          if (!claimed) {
            violations.push({
              code: "TARGET_IDENTITY_MISSING",
              message: `CLICK missing targetLabel for requested "${expectedLabel}" — refusing to guess`,
              actionIndex: i,
              requiresConfirmation: true,
            });
            blocked = true;
          } else if (!labelsMatch(claimed, expectedLabel)) {
            violations.push({
              code: "TARGET_LABEL_MISMATCH",
              message: `targetLabel "${claimed}" does not match requested "${expectedLabel}" — never substitute a different element`,
              actionIndex: i,
              requiresConfirmation: true,
            });
            blocked = true;
          }

          const confidence = action.params.targetConfidence;
          if (
            typeof confidence === "number" &&
            confidence < MIN_TARGET_CONFIDENCE
          ) {
            violations.push({
              code: "TARGET_CONFIDENCE_LOW",
              message: `targetConfidence ${confidence} below ${MIN_TARGET_CONFIDENCE} for "${claimed}"`,
              actionIndex: i,
              requiresConfirmation: true,
            });
            blocked = true;
          }
        }
      }
    }

    if (action.type === "SCROLL") {
      const { x, y } = action.params;
      if (
        (x !== undefined || y !== undefined) &&
        (typeof x !== "number" ||
          typeof y !== "number" ||
          !isCoordinateInBounds(x, y, screenshot.width, screenshot.height))
      ) {
        violations.push({
          code: "SCROLL_FOCUS_OUT_OF_BOUNDS",
          message: `SCROLL focus point outside screenshot ${screenshot.width}x${screenshot.height}`,
          actionIndex: i,
          requiresConfirmation: false,
        });
        blocked = true;
      }
    }

    if (action.type === "TYPE_TEXT") {
      const text = action.params.text;
      if (SHELL_INJECTION_PATTERNS.some((re) => re.test(text))) {
        violations.push({
          code: "BLOCKED_SCRIPT_CONTENT",
          message:
            "TYPE_TEXT content looks like shell/script execution and is blocked",
          actionIndex: i,
          requiresConfirmation: false,
        });
        blocked = true;
      }
      if (DESTRUCTIVE_TEXT_PATTERNS.some((re) => re.test(text))) {
        violations.push({
          code: "DESTRUCTIVE_TEXT_NEEDS_CONFIRMATION",
          message:
            "Typed content appears consequential; user confirmation required",
          actionIndex: i,
          requiresConfirmation: true,
        });
        blocked = true;
      }
    }

    if (action.type === "OPEN_APP") {
      const app = action.params.app;
      if (BLOCKED_APPS.some((re) => re.test(app))) {
        violations.push({
          code: "BLOCKED_APP",
          message: `Opening "${app}" is blocked by the safety layer`,
          actionIndex: i,
          requiresConfirmation: true,
        });
        blocked = true;
      }
      if (LOCK_SCREEN_APP_HINTS.some((re) => re.test(app))) {
        violations.push({
          code: "AUTH_BYPASS_ATTEMPT",
          message: "Actions targeting lock/login screens are blocked",
          actionIndex: i,
          requiresConfirmation: false,
        });
        blocked = true;
      }
    }

    if (action.type === "HOTKEY") {
      const keys = action.params.keys;
      if (isDangerousHotkey(keys)) {
        violations.push({
          code: "DANGEROUS_HOTKEY",
          message: `Hotkey [${keys.join("+")}] is blocked or requires confirmation`,
          actionIndex: i,
          requiresConfirmation: true,
        });
        blocked = true;
      }
    }

    if (
      instructionNeedsConfirm &&
      action.type !== "ASK_USER" &&
      action.type !== "DONE" &&
      action.type !== "SCREENSHOT" &&
      action.type !== "WAIT"
    ) {
      violations.push({
        code: "INSTRUCTION_REQUIRES_CONFIRMATION",
        message:
          "User instruction appears destructive or externally consequential; confirmation required",
        actionIndex: i,
        requiresConfirmation: true,
      });
      blocked = true;
    }

    const forbiddenKeys = [
      "code",
      "script",
      "command",
      "shell",
      "js",
      "javascript",
      "eval",
    ];
    for (const key of Object.keys(action.params)) {
      if (forbiddenKeys.includes(key.toLowerCase())) {
        violations.push({
          code: "FORBIDDEN_PARAM",
          message: `Parameter "${key}" is not allowed on computer actions`,
          actionIndex: i,
          requiresConfirmation: false,
        });
        blocked = true;
      }
    }

    if (!blocked) {
      safeActions.push(action);
    }
  }

  const needsConfirm = violations.some((v) => v.requiresConfirmation);
  const hardFail = violations.some((v) => !v.requiresConfirmation);

  let askUserAction: ComputerAction | undefined;
  if (needsConfirm && safeActions.length === 0) {
    const spatialOrTarget = violations.some(
      (v) =>
        v.code === "SPATIAL_CONSTRAINT_VIOLATION" ||
        v.code === "TARGET_LABEL_MISMATCH" ||
        v.code === "TARGET_IDENTITY_MISSING" ||
        v.code === "TARGET_CONFIDENCE_LOW",
    );
    const reasons = violations
      .filter((v) => v.requiresConfirmation)
      .map((v) => v.message)
      .join("; ");
    askUserAction = {
      type: "ASK_USER",
      params: {
        question: spatialOrTarget
          ? "I can't confidently identify the requested button in the current screen. Can you point me to it or clarify?"
          : "This task may perform a consequential or sensitive operation. Do you want to proceed?",
        reason: reasons,
      },
    };
  }

  return {
    ok: violations.length === 0,
    violations,
    safeActions:
      hardFail && !needsConfirm
        ? []
        : askUserAction
          ? [askUserAction]
          : safeActions,
    askUserAction,
  };
}

/**
 * Categories that should return ASK_USER rather than proceed.
 * Exposed for prompts / documentation.
 */
export const SAFETY_ASK_USER_CATEGORIES = [
  "deleting files",
  "sending important messages",
  "purchasing something",
  "changing passwords",
  "modifying security settings",
  "shutting down the machine",
  "installing unknown software",
  "disabling security software",
  "bypassing OS authentication or lock screen",
  "opening sensitive system/admin applications",
] as const;
