import type { ComputerAction, ScrollDirection, UserIntent } from "../types/index.js";
import { extractLikelyTargetLabel } from "../localization/spatial.js";
import { inferExecutionMode } from "../execution/mode.js";

export interface ClassifiedIntent {
  intent: UserIntent;
  /** Direction when intent is SCROLL. */
  scrollDirection?: ScrollDirection;
  /** Notch count for ordinary scroll (not used when scrollToEnd). */
  scrollAmount?: number;
  /** True when user asked to scroll to top/bottom/end. */
  scrollToEnd?: boolean;
  /** Extracted UI target label when applicable. */
  targetLabel?: string | null;
  /** True when the instruction is a retry/continuation of a prior task. */
  isContinuation: boolean;
}

export interface IntentValidationResult {
  ok: boolean;
  reason?: string;
  /** When rejected due to wrong semantics — escalate to user. */
  needsUserInput: boolean;
}

export interface OpenAppValidationResult {
  ok: boolean;
  reason?: string;
  needsUserInput: boolean;
}

const CONTINUATION_RE =
  /^(again|retry(\s+that)?|redo(\s+that)?|once\s+more|try\s+again)\b/i;

const CONTINUATION_PHRASE_RE =
  /\b(again\s+do\s+(the\s+)?action|do\s+(it|that|the\s+(same|previous|last)\s+(action|one|task))\s*again|do\s+the\s+previous\s+action(\s+again)?|retry\s+(the\s+)?(previous|last)\s+(action|task)|i\s+don'?t\s+see\s+it\s+done)\b/i;

/** Tokens that must never be treated as an application name. */
const APP_NAME_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "app",
  "application",
  "at",
  "bottom",
  "button",
  "by",
  "dialog",
  "drawer",
  "for",
  "from",
  "in",
  "into",
  "it",
  "left",
  "link",
  "lower",
  "menu",
  "my",
  "new",
  "of",
  "on",
  "onto",
  "or",
  "page",
  "panel",
  "please",
  "right",
  "sidebar",
  "tab",
  "tabs",
  "that",
  "the",
  "this",
  "to",
  "top",
  "upper",
  "up",
  "down",
  "via",
  "window",
  "with",
  "your",
]);

/** UI nouns that indicate “open” means interact with UI, not launch an app. */
const UI_OPEN_OBJECT_RE =
  /\b(tab|tabs|menu|menus|dropdown|dialog|dialogs|window|windows|sidebar|sidebars|panel|panels|drawer|drawers|link|links|page|pages|button|buttons|settings|preferences)\b/i;

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

/** True when the user asked to scroll all the way to an extreme end. */
export function instructionImpliesScrollToEnd(instruction: string): boolean {
  return /\b(to\s+(the\s+)?(bottom|top|end|start|beginning)|all\s+the\s+way)\b/i.test(
    instruction,
  );
}

function detectScrollAmount(text: string): number {
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
 * True when “open/launch …” clearly refers to UI (tabs, sidebar, menus, …),
 * not launching an installed desktop application.
 *
 * The word “open” alone MUST NOT imply OPEN_APP.
 */
export function instructionImpliesUiOpen(instruction: string): boolean {
  const text = instruction.trim();
  if (!text) return false;
  if (!/\b(open|launch)\b/i.test(text)) return false;

  // open new tab / open a new …
  if (/\b(open|launch)\s+(?:a\s+|the\s+)?new\b/i.test(text)) return true;

  // open in left sidebar … / open on the …
  if (/\b(open|launch)\s+(?:in|on)\b/i.test(text)) return true;

  // open the left/right sidebar …
  if (
    /\b(open|launch)\s+(?:the\s+)?(?:left|right|top|bottom|upper|lower)\b/i.test(
      text,
    )
  ) {
    return true;
  }

  // Any open/launch that mentions a UI object anywhere after the verb
  if (
    /\b(open|launch)\b[\s\S]{0,80}\b(tab|tabs|menu|menus|dropdown|dialog|sidebar|panel|drawer|link|links|page|pages)\b/i.test(
      text,
    )
  ) {
    return true;
  }

  // open the sidebar / open settings (UI) without “application/app”
  if (
    /\b(open|launch)\s+(?:the\s+)?(?:sidebar|menu|settings|preferences)\b/i.test(
      text,
    ) &&
    !/\b(application|app)\b/i.test(text)
  ) {
    return true;
  }

  // Browser-context: open … on/in Chrome/Google/Safari/…
  if (
    /\b(open|launch)\b.+\b(in|on)\s+(?:google\s+)?(?:chrome|safari|firefox|edge|brave|browser|google)\b/i.test(
      text,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Whether a candidate string looks like a real desktop application name.
 * Does NOT resolve installed apps — that is the desktop agent’s job.
 * Rejects stopwords and UI nouns that caused OPEN_APP("new") / OPEN_APP("in").
 */
export function looksLikeApplicationName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 64) return false;

  // Must start with a letter
  if (!/^[A-Za-z]/.test(trimmed)) return false;

  // Reject path-like / shell-like values
  if (/[\\/]/.test(trimmed) || /\.(app|exe|dmg|pkg)$/i.test(trimmed)) {
    return false;
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) return false;

  for (const token of tokens) {
    const lower = token.toLowerCase().replace(/['"]/g, "");
    if (APP_NAME_STOPWORDS.has(lower)) return false;
    if (UI_OPEN_OBJECT_RE.test(lower)) return false;
    // Reject pure prepositions / tiny tokens
    if (lower.length < 2) return false;
  }

  // Single-token UI-ish labels that are rarely apps when used with “open”
  const single = tokens[0]?.toLowerCase() ?? "";
  if (
    tokens.length === 1 &&
    /^(dashboard|processes|devices|settings|preferences|chatgpt|sidebar|menu)$/i.test(
      single,
    )
  ) {
    return false;
  }

  return true;
}

/**
 * Extract a semantic application name from an open/launch/start instruction.
 * Never uses “the next word after open” alone without validation.
 */
export function extractOpenAppName(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // “open the Telegram application” / “launch Slack app”
  const withAppNoun =
    /\b(?:open|launch|start)\s+(?:the\s+)?(?:['"]?)([A-Za-z][\w .'-]{0,48}?)(?:['"]?)\s+(?:application|app)\b/i.exec(
      trimmed,
    );
  if (withAppNoun?.[1]) {
    const name = cleanAppName(withAppNoun[1]);
    if (name && looksLikeApplicationName(name)) return name;
  }

  // “open application Slack” / “launch app Telegram”
  const appNounFirst =
    /\b(?:open|launch|start)\s+(?:the\s+)?(?:application|app)\s+(?:named\s+|called\s+)?(?:['"]?)([A-Za-z][\w .'-]{0,48}?)(?:['"]?)\s*$/i.exec(
      trimmed,
    );
  if (appNounFirst?.[1]) {
    const name = cleanAppName(appNounFirst[1]);
    if (name && looksLikeApplicationName(name)) return name;
  }

  // “open Slack” / “launch Telegram” / “open Google Chrome” (end-anchored)
  const simple =
    /\b(?:open|launch|start)\s+(?:the\s+)?(?:['"]?)([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+){0,3})(?:['"]?)\s*$/i.exec(
      trimmed,
    );
  if (simple?.[1]) {
    const name = cleanAppName(simple[1]);
    if (name && looksLikeApplicationName(name)) return name;
  }

  return null;
}

function cleanAppName(raw: string): string {
  return raw
    .trim()
    .replace(/^the\s+/i, "")
    .replace(/\s+(application|app)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Validate an OPEN_APP action before it reaches the desktop agent.
 * Rejects empty / stopword / UI-noun names. Does NOT invent a substitute app.
 */
export function validateOpenAppAction(
  action: ComputerAction,
  instruction?: string,
): OpenAppValidationResult {
  if (action.type !== "OPEN_APP") {
    return { ok: true, needsUserInput: false };
  }

  if (instruction && instructionImpliesUiOpen(instruction)) {
    return {
      ok: false,
      needsUserInput: true,
      reason:
        'OPEN_APP rejected: the instruction describes a UI interaction (tab/sidebar/menu/…), not launching a desktop application. The word "open" does not imply OPEN_APP.',
    };
  }

  const app =
    typeof action.params.app === "string" ? action.params.app.trim() : "";
  if (!app) {
    return {
      ok: false,
      needsUserInput: true,
      reason: "OPEN_APP requires a non-empty application name.",
    };
  }

  if (!looksLikeApplicationName(app)) {
    return {
      ok: false,
      needsUserInput: true,
      reason: `OPEN_APP("${app}") is not a valid desktop application name. Refusing to guess another app or convert to a different action.`,
    };
  }

  return { ok: true, needsUserInput: false };
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
    const scrollToEnd = instructionImpliesScrollToEnd(text);
    return {
      intent: "SCROLL",
      scrollDirection,
      scrollToEnd,
      scrollAmount: scrollToEnd ? undefined : detectScrollAmount(text),
      isContinuation,
    };
  }

  // Browser “open new tab …” → NOT OPEN_APP. Leave UNKNOWN so vision may
  // choose CLICK or HOTKEY; never take the next word as an app name.
  if (/\b(open|launch)\s+(?:a\s+|the\s+)?new\s+tab\b/i.test(text)) {
    return { intent: "UNKNOWN", isContinuation };
  }

  // UI “open … tab/sidebar/menu/…” → CLICK (never OPEN_APP).
  // The word “open” alone is not OPEN_APP.
  if (instructionImpliesUiOpen(text)) {
    return {
      intent: "CLICK",
      targetLabel: extractLikelyTargetLabel(text),
      isContinuation,
    };
  }

  // Desktop application launch — only when semantics clearly mean an app.
  if (/\b(open|launch|start)\b/i.test(text)) {
    const appName = extractOpenAppName(text);
    if (appName) {
      return {
        intent: "OPEN_APP",
        targetLabel: appName,
        isContinuation,
      };
    }
    // Ambiguous “open …” without a resolvable app name → let vision decide.
    // Do NOT take the next token after “open” as an app name.
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
    // Still reject invalid OPEN_APP even when intent is UNKNOWN
    for (const action of actions) {
      if (action.type === "OPEN_APP") {
        const openCheck = validateOpenAppAction(action, instruction);
        if (!openCheck.ok) {
          return {
            ok: false,
            needsUserInput: true,
            reason: openCheck.reason,
          };
        }
      }
    }
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

    if (action.type === "OPEN_APP") {
      const openCheck = validateOpenAppAction(action, instruction);
      if (!openCheck.ok) {
        return {
          ok: false,
          needsUserInput: true,
          reason: openCheck.reason,
        };
      }
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
