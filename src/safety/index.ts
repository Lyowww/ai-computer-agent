import type { ComputerAction, Screenshot } from "../types/index.js";
import { isCoordinateInBounds } from "../utils/index.js";

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
  /powershell/i,
  /cmd\.exe/i,
  /command\s*prompt/i,
  /windows\s*terminal/i,
  /registry\s*editor/i,
  /regedit/i,
  /disk\s*utility/i,
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

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/^control$/, "ctrl").replace(/^cmd$/, "meta").replace(/^command$/, "meta").replace(/^option$/, "alt").replace(/^return$/, "enter");
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
): params is { x: number; y: number } {
  return (
    "x" in params &&
    "y" in params &&
    typeof (params as { x: unknown }).x === "number" &&
    typeof (params as { y: unknown }).y === "number"
  );
}

/**
 * Action Safety Layer.
 * Validates that AI-produced actions stay within the allowed computer-control surface
 * and blocks or escalates destructive / security-sensitive operations.
 */
export function validateActionSafety(
  actions: ComputerAction[],
  screenshot: Screenshot,
  options?: { userInstruction?: string },
): SafetyCheckResult {
  const violations: SafetyViolation[] = [];
  const safeActions: ComputerAction[] = [];

  const instruction = options?.userInstruction ?? "";
  const instructionNeedsConfirm =
    DESTRUCTIVE_TEXT_PATTERNS.some((re) => re.test(instruction));

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    let blocked = false;

    // Coordinate bounds
    if (
      (action.type === "CLICK" ||
        action.type === "DOUBLE_CLICK" ||
        action.type === "MOVE_MOUSE") &&
      hasCoordinateParams(action.params)
    ) {
      const { x, y } = action.params;
      if (!isCoordinateInBounds(x, y, screenshot.width, screenshot.height)) {
        violations.push({
          code: "COORDINATE_OUT_OF_BOUNDS",
          message: `Coordinate (${x}, ${y}) outside screenshot ${screenshot.width}x${screenshot.height}`,
          actionIndex: i,
          requiresConfirmation: false,
        });
        blocked = true;
      }
    }

    // TYPE_TEXT injection / script attempts
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

    // OPEN_APP restrictions
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

    // Dangerous hotkeys
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

    // KEY_PRESS that looks like force-quit / secure attention
    if (action.type === "KEY_PRESS") {
      const key = normalizeKey(action.params.key);
      if (key === "f4" || key === "delete" || key === "power") {
        // Not automatically blocked alone, but flagged with instruction context below
      }
    }

    // Instruction-level consequential ops: force ASK_USER before continuing
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

    // Disallow inventing executable payloads as params
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
    const reasons = violations
      .filter((v) => v.requiresConfirmation)
      .map((v) => v.message)
      .join("; ");
    askUserAction = {
      type: "ASK_USER",
      params: {
        question:
          "This task may perform a consequential or sensitive operation. Do you want to proceed?",
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
] as const;
