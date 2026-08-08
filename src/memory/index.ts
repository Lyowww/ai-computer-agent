import type {
  ActionResult,
  ComputerAction,
  Screenshot,
  TaskState,
  TaskStatus,
} from "../types/index.js";
import { actionFingerprint } from "../actions/index.js";
import { createId, nowIso } from "../utils/index.js";

/** Cap retained history to avoid unbounded memory growth. */
const MAX_PREVIOUS_ACTIONS = 50;
const MAX_ACTION_RESULTS = 50;
const MAX_NOTES = 20;

export interface CreateTaskOptions {
  taskId?: string;
  userInstruction: string;
  screenshot?: Screenshot | null;
}

export function createTaskState(options: CreateTaskOptions): TaskState {
  const now = nowIso();
  return {
    taskId: options.taskId ?? createId("task"),
    userInstruction: options.userInstruction,
    currentScreenshot: options.screenshot
      ? stripScreenshotImage(options.screenshot)
      : null,
    previousActions: [],
    actionResults: [],
    iteration: 0,
    status: "pending",
    error: null,
    createdAt: now,
    updatedAt: now,
    notes: [],
  };
}

/**
 * Keep dimensions for context, but never retain raw screenshot bytes in task state.
 */
export function stripScreenshotImage(screenshot: Screenshot): Screenshot {
  return {
    width: screenshot.width,
    height: screenshot.height,
    image: "[stripped]",
    mimeType: screenshot.mimeType,
  };
}

export function updateScreenshot(
  state: TaskState,
  screenshot: Screenshot,
): TaskState {
  return {
    ...state,
    // Store dimensions only — full image is passed per-request to planNextAction.
    currentScreenshot: stripScreenshotImage(screenshot),
    updatedAt: nowIso(),
  };
}

export function recordPlannedActions(
  state: TaskState,
  actions: ComputerAction[],
  status: TaskStatus,
): TaskState {
  const previousActions = [...state.previousActions, ...actions].slice(
    -MAX_PREVIOUS_ACTIONS,
  );
  return {
    ...state,
    previousActions,
    iteration: state.iteration + 1,
    status,
    updatedAt: nowIso(),
  };
}

export function recordActionResults(
  state: TaskState,
  results: ActionResult[],
): TaskState {
  const actionResults = [...state.actionResults, ...results].slice(
    -MAX_ACTION_RESULTS,
  );
  return {
    ...state,
    actionResults,
    updatedAt: nowIso(),
  };
}

export function setTaskError(state: TaskState, error: string): TaskState {
  return {
    ...state,
    status: "failed",
    error,
    updatedAt: nowIso(),
  };
}

export function setTaskStatus(
  state: TaskState,
  status: TaskStatus,
): TaskState {
  return {
    ...state,
    status,
    updatedAt: nowIso(),
  };
}

/**
 * Detect repeated identical unsuccessful actions (loop protection signal).
 */
export function countConsecutiveFailedRepeats(
  results: ActionResult[],
): { count: number; fingerprint: string | null } {
  if (results.length === 0) {
    return { count: 0, fingerprint: null };
  }

  let i = results.length - 1;
  // Walk back through trailing failures
  while (i >= 0 && !results[i].success) {
    i--;
  }
  const failedTail = results.slice(i + 1);
  if (failedTail.length === 0) {
    return { count: 0, fingerprint: null };
  }

  const lastFp = actionFingerprint(failedTail[failedTail.length - 1].action);
  let count = 0;
  for (let j = failedTail.length - 1; j >= 0; j--) {
    if (actionFingerprint(failedTail[j].action) === lastFp) {
      count++;
    } else {
      break;
    }
  }
  return { count, fingerprint: lastFp };
}

/**
 * Count how many times the same action fingerprint appears consecutively
 * at the end of previousActions (even without explicit failure records).
 */
export function countConsecutiveSameActions(
  actions: ComputerAction[],
): { count: number; fingerprint: string | null } {
  if (actions.length === 0) {
    return { count: 0, fingerprint: null };
  }
  const lastFp = actionFingerprint(actions[actions.length - 1]);
  let count = 0;
  for (let i = actions.length - 1; i >= 0; i--) {
    if (actionFingerprint(actions[i]) === lastFp) {
      count++;
    } else {
      break;
    }
  }
  return { count, fingerprint: lastFp };
}

function summarizeAction(action: ComputerAction): string {
  if (action.type === "TYPE_TEXT") {
    return `TYPE_TEXT fp=${actionFingerprint(action)} len=${action.params.text.length}`;
  }
  if (action.type === "ASK_USER") {
    return `ASK_USER fp=${actionFingerprint(action)}`;
  }
  return `${action.type} ${JSON.stringify(action.params)}`;
}

export function summarizeHistoryForPrompt(state: TaskState): string {
  const lines: string[] = [];
  lines.push(`Task ID: ${state.taskId}`);
  lines.push(`Iteration: ${state.iteration}`);
  lines.push(`Status: ${state.status}`);
  lines.push(`User instruction: ${state.userInstruction}`);

  if (state.previousActions.length > 0) {
    lines.push("Previous actions:");
    const recent = state.previousActions.slice(-12);
    for (const action of recent) {
      lines.push(`- ${summarizeAction(action)}`);
    }
  }

  if (state.actionResults.length > 0) {
    lines.push("Recent action results:");
    const recent = state.actionResults.slice(-12);
    for (const result of recent) {
      lines.push(
        `- ${result.action.type} [${actionFingerprint(result.action)}]: ${result.success ? "success" : "FAILED"}${result.error ? ` (${result.error})` : ""}`,
      );
    }
  }

  if (state.notes && state.notes.length > 0) {
    lines.push("Notes:");
    for (const note of state.notes.slice(-MAX_NOTES)) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
}
