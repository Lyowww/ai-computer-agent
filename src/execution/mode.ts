/**
 * Distinguishes one-shot user requests from multi-step goals.
 * Single-action tasks must execute once and terminate — never auto-loop.
 */

export type ExecutionMode = "single_action" | "multi_step";

const MULTI_STEP_CONNECTOR =
  /\b(and then|then|after that|afterwards|followed by|next|finally)\b/i;

const ACTION_VERB =
  /\b(open|launch|start|click|double[-\s]?click|type|press|hit|go to|navigate|visit|create|write|enter|select|scroll|drag|close|quit|delete|remove|move|copy|paste|search|download|upload|login|log in|sign in|refresh|reload|focus|switch|install|save|send|submit|fill|screenshot|capture)\b/gi;

/** Compact multi-goal phrases without an explicit “and then” connector. */
const COMPACT_MULTI_STEP =
  /\b(open|launch|start)\b[\s\S]{0,80}\b(scroll|type|click|screenshot|capture|go to|navigate)\b/i;

const SCROLL_THEN_SCREENSHOT =
  /\bscroll\b[\s\S]{0,80}\b(screenshot|capture|give\s+me\s+(a\s+)?(?:screen[\s-]?shot|picture))\b/i;

/**
 * Infer whether a user instruction is a single atomic action or a multi-step goal.
 * Defaults to single_action — never assume autonomous continuation.
 */
export function inferExecutionMode(instruction: string): ExecutionMode {
  const text = instruction.trim();
  if (!text) return "single_action";

  if (MULTI_STEP_CONNECTOR.test(text)) {
    return "multi_step";
  }

  if (COMPACT_MULTI_STEP.test(text) || SCROLL_THEN_SCREENSHOT.test(text)) {
    return "multi_step";
  }

  const sentences = text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length >= 2) {
    const verbHits = sentences.filter((s) => {
      ACTION_VERB.lastIndex = 0;
      return ACTION_VERB.test(s);
    }).length;
    if (verbHits >= 2) return "multi_step";
  }

  ACTION_VERB.lastIndex = 0;
  const verbs = text.match(ACTION_VERB) ?? [];
  if (verbs.length >= 2 && /\band\b|,/i.test(text)) {
    return "multi_step";
  }

  // "Open VS Code, create a file, and type hello"
  const commaCount = (text.match(/,/g) ?? []).length;
  if (commaCount >= 1 && verbs.length >= 2) {
    return "multi_step";
  }

  return "single_action";
}
