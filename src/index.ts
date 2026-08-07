/**
 * @petai/ai-computer-agent
 *
 * AI brain / orchestrator for remote computer-control.
 * Produces validated structured actions from natural language + screenshots.
 * Does NOT execute mouse/keyboard actions — the desktop agent does that.
 */

export { Orchestrator, planNextAction } from "./orchestrator/index.js";
export type { OrchestratorOptions } from "./orchestrator/index.js";

export {
  createAiProvider,
  createAiProviderFromConfig,
  OpenRouterProvider,
  GeminiProvider,
} from "./ai/index.js";

export { validateActionSafety, SAFETY_ASK_USER_CATEGORIES } from "./safety/index.js";
export type { SafetyCheckResult, SafetyViolation } from "./safety/index.js";

export {
  ComputerActionSchema,
  AiPlanResponseSchema,
  ScreenshotSchema,
} from "./schemas/index.js";

export {
  parseAction,
  tryParseAction,
  actionFingerprint,
  SUPPORTED_ACTIONS,
} from "./actions/index.js";

export {
  createTaskState,
  recordActionResults,
  summarizeHistoryForPrompt,
} from "./memory/index.js";

export { loadConfig, assertProviderCredentials } from "./utils/config.js";
export { planWithVision } from "./vision/index.js";

export type {
  Screenshot,
  ComputerAction,
  AiPlanResponse,
  ActionResult,
  TaskState,
  PlanNextActionInput,
  PlanNextActionResult,
  AiProvider,
  AiProviderName,
  OrchestratorConfig,
  AgentStatus,
  TaskStatus,
  ActionType,
} from "./types/index.js";
