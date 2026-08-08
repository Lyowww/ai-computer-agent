import type { AgentStatus, ComputerAction } from "../types/index.js";
import type { ExecutionMode } from "./mode.js";

export type TaskLifecycleStatus =
  | "PENDING"
  | "RUNNING"
  | "WAITING_FOR_USER"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

const TERMINAL: ReadonlySet<TaskLifecycleStatus> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export function isTerminalTaskStatus(status: TaskLifecycleStatus): boolean {
  return TERMINAL.has(status);
}

export function agentStatusToLifecycle(
  status: AgentStatus,
): TaskLifecycleStatus {
  switch (status) {
    case "COMPLETED":
      return "COMPLETED";
    case "FAILED":
      return "FAILED";
    case "NEEDS_USER_INPUT":
      return "WAITING_FOR_USER";
    case "ACTION_REQUIRED":
    default:
      return "RUNNING";
  }
}

export type AfterActionsDecision =
  | { kind: "complete"; summary: string }
  | { kind: "fail"; error: string }
  | { kind: "replan" }
  | { kind: "noop" };

/**
 * After planned actions finish executing, decide whether the task is done
 * or whether another AI planning cycle is allowed.
 */
export function decideAfterActionBatch(input: {
  mode: ExecutionMode;
  allSucceeded: boolean;
  lastError?: string;
  taskStatus: TaskLifecycleStatus;
}): AfterActionsDecision {
  if (isTerminalTaskStatus(input.taskStatus)) {
    return { kind: "noop" };
  }

  if (input.mode === "single_action") {
    if (input.allSucceeded) {
      return {
        kind: "complete",
        summary: "Action completed successfully",
      };
    }
    return {
      kind: "fail",
      error: input.lastError ?? "Action failed",
    };
  }

  // multi_step: continue planning until the model returns COMPLETED
  return { kind: "replan" };
}

/**
 * Whether SCREENSHOT / WAIT-only plans may trigger another capture+plan cycle.
 * Single-action tasks must never enter a screenshot→AI→screenshot loop.
 */
export function shouldReplanOnNonExecutablePlan(input: {
  mode: ExecutionMode;
  status: AgentStatus;
  hasDone: boolean;
}): boolean {
  if (input.status === "COMPLETED" || input.hasDone) return false;
  if (input.status === "FAILED") return false;
  if (input.status === "NEEDS_USER_INPUT") return false;
  if (input.mode === "single_action") return false;
  return true;
}

const FAKE_APPROVAL_TEXT =
  /\b(click(?:ing)?\s+['"]?(approve|ai)['"]?|acknowledg(?:e|ing)\s+user\s+approval|approving\s+(?:the\s+)?(?:potential\s+)?action|typing\s+the\s+user'?s?\s+instruction|waiting\s+for\s+further\s+instructions|continue\s+the\s+task\s+as\s+approved)\b/i;

/**
 * Detect plans that invent fake user approval / dashboard UI interaction
 * instead of returning NEEDS_USER_INPUT for a real human.
 */
export function looksLikeFakeUserApproval(input: {
  message?: string;
  reasoning_summary?: string;
  actions: ComputerAction[];
}): boolean {
  const text = `${input.message ?? ""} ${input.reasoning_summary ?? ""}`;
  if (FAKE_APPROVAL_TEXT.test(text)) return true;

  for (const action of input.actions) {
    if (action.type === "TYPE_TEXT") {
      const typed = action.params.text.toLowerCase();
      if (
        typed.startsWith("approved:") ||
        typed.includes("click the refresh") ||
        /^approve\b/.test(typed)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function toNeedsUserInputPlan(question: string): {
  status: "NEEDS_USER_INPUT";
  reasoning_summary: string;
  actions: ComputerAction[];
  message: string;
} {
  return {
    status: "NEEDS_USER_INPUT",
    reasoning_summary:
      "User confirmation is required; do not simulate approval in the UI.",
    actions: [
      {
        type: "ASK_USER",
        params: {
          question,
          reason: "Real user input required — automatic approval is forbidden",
        },
      },
    ],
    message: question,
  };
}
