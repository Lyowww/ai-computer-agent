export { inferExecutionMode } from "./mode.js";
export type { ExecutionMode } from "./mode.js";

export {
  isTerminalTaskStatus,
  agentStatusToLifecycle,
  decideAfterActionBatch,
  shouldReplanOnNonExecutablePlan,
  looksLikeFakeUserApproval,
  toNeedsUserInputPlan,
  instructionRequestsScreenshot,
  shouldCompleteAfterScreenshotBatch,
} from "./lifecycle.js";
export type {
  TaskLifecycleStatus,
  AfterActionsDecision,
} from "./lifecycle.js";
