import type { ComputerAction, ScrollDirection, UserIntent } from "../types/index.js";
import { extractLikelyTargetLabel } from "../localization/spatial.js";
import { inferExecutionMode } from "../execution/mode.js";

export interface ClassifiedIntent {
  intent: UserIntent;
  /** Direction when intent is SCROLL. */
  scrollDirection?: ScrollDirection;
  /** Larger amount for “to bottom/top”. */
  scrollAmount?: number;
  /** Extracted UI target label when applicable. */
  targetLabel?: string | null;
  /** True when the instruction is a retry/continuation of a prior task. */
  isContinuation: boolean;
}

const CONTINUATION_RE =
  /^(again|retry(\s+that)?|redo(\s+that)?|once\s+more|try\s+again)\b/i;

const CONTINUATION_PHRASE_RE =
  /\b(again\s+do\s+(the\s+)?action|do\s+(it|that|the\s+(same|previous|last)\s+(action|one|task))\s*again|do\s+the\s+previous\s+action(\s+again)?|retry\s+(the\s+)?(previous|last)\s+(action|task)|i\s+don'?t\s+see\s+it\s+done)\b/i;

/**
 * Detect “again / retry that” style continuation requests.
 * These must NOT invent a new task — they retry the prior identifiable instruction.
 */
export function isContinuationRequest(instruction: string): boolean {
  const text = instruction.trim();
  if (!text) return false;
  if (CONTINUATION_RE.test(text)) return true;
  if (CONTINUATION_PHRASE_RE.test(text)) return true;
  // Short “again …” with no new concrete verb target
  if (/^again\b/i.test(text) && text.split(/\s+/).length <= 12) return true;
  return false;
}

function detectScrollDirection(text: string): ScrollDirection {
  if (/\b(scroll\s+)?(up|upward|upwards)\b/i.test(text)) return "up";
  if (/\b(scroll\s+)?(left)\b/i.test(text)) return "left";
  if (/\b(scroll\s+)?(right)\b/i.test(text)) return "right";
  // “to bottom / to the end / down” → down
  return "down";
}

function detectScrollAmount(text: string, direction: ScrollDirection): number {
  const extreme =
    /\b(to\s+(the\s+)?(bottom|top|end|start|beginning)|all\s+the\s+way)\b/i.test(
      text,
    );
  if (extreme) return direction === "up" || direction === "down" ? 25 : 15;
  const n = /\b(\d+)\s*(times?|notches?|ticks?|lines?)?\b/i.exec(text);
  if (n?.[1]) {
    const parsed = Number(n[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(100, Math.max(1, Math.round(parsed)));
    }
  }
  return 5;
}

/**
 * Classify the user’s instruction BEFORE vision planning.
 * The vision model must not change this fundamental action type.
 * Multi-step goals stay UNKNOWN so later steps are not locked to the first verb.
 */
export function classifyUserIntent(instruction: string): ClassifiedIntent {
  const text = instruction.trim();
  const isContinuation = isContinuationRequest(text);

  if (!text) {
    return { intent: "UNKNOWN", isContinuation };
  }

  // Multi-step goals: do not lock to the first verb (open…and then type…).
  if (inferExecutionMode(text) === "multi_step") {
    return { intent: "UNKNOWN", isContinuation };
  }

  // Order matters: more specific verbs first.
  if (/\bdouble[\s-]?click\b/i.test(text)) {
    return {
      intent: "DOUBLE_CLICK",
      targetLabel: extractLikelyTargetLabel(text),
      isContinuation,
    };
  }

  if (/\bscroll\b/i.test(text)) {
    const scrollDirection = detectScrollDirection(text);
    return {
      intent: "SCROLL",
      scrollDirection,
      scrollAmount: detectScrollAmount(text, scrollDirection),
      isContinuation,
    };
  }

  if (
    /\b(open|launch|start)\s+(?:the\s+)?(?:app\s+)?[A-Za-z]/i.test(text) &&
    !/\b(open|launch)\s+(?:the\s+)?(?:tab|menu|dropdown|dialog|window)\b/i.test(
      text,
    )
  ) {
    return {
      intent: "OPEN_APP",
      targetLabel: extractOpenAppName(text),
      isContinuation,
    };
  }

  if (/\b(type|enter|input|write)\b/i.test(text) && !/\bpress\b/i.test(text)) {
    return { intent: "TYPE", isContinuation };
  }

  if (/\b(hotkey|shortcut|press\s+(?:keys?|combo))\b/i.test(text)) {
    return { intent: "HOTKEY", isContinuation };
  }

  if (/\b(press|hit)\s+(?:the\s+)?(?:key\s+)?[A-Za-z]/i.test(text)) {
    return { intent: "KEY_PRESS", isContinuation };
  }

  if (/\b(wait|pause|sleep)\b/i.test(text)) {
    return { intent: "WAIT", isContinuation };
  }

  if (/\b(click|tap|select)\b/i.test(text)) {
    return {
      intent: "CLICK",
      targetLabel: extractLikelyTargetLabel(text),
      isContinuation,
    };
  }

  // Bare “Devices tab” / refresh-style without explicit verb → treat as CLICK
  if (extractLikelyTargetLabel(text)) {
    return {
      intent: "CLICK",
      targetLabel: extractLikelyTargetLabel(text),
      isContinuation,
    };
  }

  return { intent: "UNKNOWN", isContinuation };
}

function extractOpenAppName(text: string): string | null {
  const m =
    /\b(?:open|launch|start)\s+(?:the\s+)?(?:app\s+)?(?:['"]?)([A-Za-z][\w .'-]{0,60}?)(?:['"]?)(?:\s|$)/i.exec(
      text,
    );
  return m?.[1]?.trim() ?? null;
}

/** Map classified intent → allowed ComputerAction types (plus meta actions). */
export function allowedActionTypesForIntent(
  intent: UserIntent,
): ReadonlySet<string> {
  const meta = ["ASK_USER", "DONE", "SCREENSHOT", "WAIT"] as const;
  switch (intent) {
    case "CLICK":
      return new Set(["CLICK", ...meta]);
    case "DOUBLE_CLICK":
      return new Set(["DOUBLE_CLICK", ...meta]);
    case "SCROLL":
      return new Set(["SCROLL", ...meta]);
    case "TYPE":
      return new Set(["TYPE_TEXT", ...meta]);
    case "KEY_PRESS":
      return new Set(["KEY_PRESS", ...meta]);
    case "HOTKEY":
      return new Set(["HOTKEY", ...meta]);
    case "OPEN_APP":
      return new Set(["OPEN_APP", ...meta]);
    case "WAIT":
      return new Set(["WAIT", ...meta]);
    case "UNKNOWN":
    default:
      // Unknown: still block nothing at the type level; other validators apply.
      return new Set([
        "CLICK",
        "DOUBLE_CLICK",
        "MOVE_MOUSE",
        "SCROLL",
        "TYPE_TEXT",
        "KEY_PRESS",
        "HOTKEY",
        "OPEN_APP",
        "WAIT",
        "SCREENSHOT",
        "DONE",
        "ASK_USER",
      ]);
  }
}

export interface IntentValidationResult {
  ok: boolean;
  reason?: string;
  /** When rejected due to wrong semantics — escalate to user. */
  needsUserInput: boolean;
}

/**
 * Validate structured actions against classified user intent.
 * reasoning_summary is NEVER consulted — only action.type / params.
 */
export function validateActionAgainstIntent(
  instruction: string,
  actions: ComputerAction[],
  classified?: ClassifiedIntent,
): IntentValidationResult {
  const intentInfo = classified ?? classifyUserIntent(instruction);
  const { intent } = intentInfo;

  if (intent === "UNKNOWN" || actions.length === 0) {
    return { ok: true, needsUserInput: false };
  }

  const allowed = allowedActionTypesForIntent(intent);
  const executable = actions.filter(
    (a) => a.type !== "DONE" && a.type !== "ASK_USER" && a.type !== "SCREENSHOT",
  );

  // Pure ASK_USER / DONE plans are always ok (uncertainty / completion).
  if (executable.length === 0) {
    return { ok: true, needsUserInput: false };
  }

  for (const action of executable) {
    if (!allowed.has(action.type)) {
      return {
        ok: false,
        needsUserInput: true,
        reason: `User intent is ${intent} but model proposed ${action.type}. Action rejected — never substitute a different action type.`,
      };
    }

    if (action.type === "SCROLL" && intentInfo.scrollDirection) {
      if (action.params.direction !== intentInfo.scrollDirection) {
        // Soft: allow opposite only if instruction was ambiguous; otherwise reject.
        const explicit =
          /\b(up|down|left|right|bottom|top|end|beginning)\b/i.test(instruction);
        if (explicit && action.params.direction !== intentInfo.scrollDirection) {
          // “to bottom” → down; “to top” → up
          const expected = intentInfo.scrollDirection;
          if (action.params.direction !== expected) {
            return {
              ok: false,
              needsUserInput: true,
              reason: `SCROLL direction mismatch: expected ${expected}, got ${action.params.direction}`,
            };
          }
        }
      }
    }

    if (
      (action.type === "CLICK" || action.type === "DOUBLE_CLICK") &&
      intentInfo.targetLabel
    ) {
      const claimed =
        typeof action.params.targetLabel === "string"
          ? action.params.targetLabel.trim()
          : "";
      // Missing targetLabel is enforced by the safety layer (after hard bounds checks).
      // Here we only reject explicit substitutions.
      if (claimed && !labelsMatch(claimed, intentInfo.targetLabel)) {
        return {
          ok: false,
          needsUserInput: true,
          reason: `Requested target "${intentInfo.targetLabel}" but model targeted "${claimed}". Never substitute a different element.`,
        };
      }
      const confidence = action.params.targetConfidence;
      if (typeof confidence === "number" && confidence < 0.75) {
        return {
          ok: false,
          needsUserInput: true,
          reason: `Target confidence ${confidence} is too low for "${claimed || intentInfo.targetLabel}". Asking user instead of guessing.`,
        };
      }
    }
  }

  // Single-action intents should not emit unrelated extras
  if (
    executable.length > 1 &&
    executable.some((a) => a.type !== executable[0].type)
  ) {
    return {
      ok: false,
      needsUserInput: true,
      reason: `Intent ${intent} must not mix unrelated action types in one plan.`,
    };
  }

  return { ok: true, needsUserInput: false };
}

function labelsMatch(claimed: string, expected: string): boolean {
  const a = claimed.trim().toLowerCase();
  const b = expected.trim().toLowerCase();
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  return false;
}

/**
 * Resolve a continuation instruction to a prior task instruction, if available.
 */
export function resolveContinuationInstruction(
  instruction: string,
  previousInstruction?: string | null,
): { instruction: string; unresolved: boolean } {
  if (!isContinuationRequest(instruction)) {
    return { instruction, unresolved: false };
  }
  const prev = previousInstruction?.trim();
  if (!prev || isContinuationRequest(prev)) {
    return { instruction, unresolved: true };
  }
  return { instruction: prev, unresolved: false };
}
