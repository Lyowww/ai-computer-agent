import type {
  ActionResult,
  ComputerAction,
  Screenshot,
  TaskState,
  TaskStatus,
} from "../types/index.js";
import { actionFingerprint } from "../actions/index.js";
import { createId, nowIso } from "../utils/index.js";

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
    currentScreenshot: options.screenshot ?? null,
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

export function updateScreenshot(
  state: TaskState,
  screenshot: Screenshot,
): TaskState {
  return {
    ...state,
    currentScreenshot: screenshot,
    updatedAt: nowIso(),
  };
}

export function recordPlannedActions(
  state: TaskState,
  actions: ComputerAction[],
  status: TaskStatus,
): TaskState {
  return {
    ...state,
    previousActions: [...state.previousActions, ...actions],
    iteration: state.iteration + 1,
    status,
    updatedAt: nowIso(),
  };
}

export function recordActionResults(
  state: TaskState,
  results: ActionResult[],
): TaskState {
  return {
    ...state,
    actionResults: [...state.actionResults, ...results],
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
      lines.push(`- ${action.type} ${JSON.stringify(action.params)}`);
    }
  }

  if (state.actionResults.length > 0) {
    lines.push("Recent action results:");
    const recent = state.actionResults.slice(-12);
    for (const result of recent) {
      lines.push(
        `- ${result.action.type}: ${result.success ? "success" : "FAILED"}${result.error ? ` (${result.error})` : ""}`,
      );
    }
  }

  return lines.join("\n");
}
