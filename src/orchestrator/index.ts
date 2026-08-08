import type {
  AiPlanResponse,
  AiProvider,
  ComputerAction,
  OrchestratorConfig,
  PlanNextActionInput,
  PlanNextActionResult,
  TaskState,
} from "../types/index.js";
import { ScreenshotSchema, AiPlanResponseSchema } from "../schemas/index.js";
import { createAiProviderFromConfig } from "../ai/index.js";
import { loadConfig, assertProviderCredentials } from "../utils/config.js";
import { planWithVision } from "../vision/index.js";
import { validateActionSafety } from "../safety/index.js";
import { actionFingerprint } from "../actions/index.js";
import {
  createTaskState,
  updateScreenshot,
  recordPlannedActions,
  setTaskError,
  setTaskStatus,
  summarizeHistoryForPrompt,
  countConsecutiveFailedRepeats,
  countConsecutiveSameActions,
} from "../memory/index.js";

export interface OrchestratorOptions {
  config?: Partial<OrchestratorConfig>;
  /** Inject a custom provider (useful for tests). */
  provider?: AiProvider;
}

/**
 * Iterative AI orchestrator.
 * Produces validated structured actions — never controls the computer directly.
 * Each planNextAction() call is a single planning step (not an infinite loop).
 */
export class Orchestrator {
  private readonly config: OrchestratorConfig;
  private readonly provider: AiProvider;

  constructor(options: OrchestratorOptions = {}) {
    this.config = loadConfig(options.config ?? {});
    if (options.provider) {
      this.provider = options.provider;
    } else {
      assertProviderCredentials(this.config);
      this.provider = createAiProviderFromConfig(this.config);
    }
  }

  getConfig(): Readonly<OrchestratorConfig> {
    return this.config;
  }

  /**
   * Primary public API: analyze instruction + screenshot and return the next plan.
   */
  async planNextAction(
    input: PlanNextActionInput,
  ): Promise<PlanNextActionResult> {
    const screenshotParse = ScreenshotSchema.safeParse(input.screenshot);
    if (!screenshotParse.success) {
      throw new Error(
        `Invalid screenshot: ${screenshotParse.error.message}`,
      );
    }
    const screenshot = screenshotParse.data;

    let state: TaskState =
      input.taskState ??
      createTaskState({
        taskId: input.taskId,
        userInstruction: input.userInstruction,
        screenshot,
      });

    // Merge caller-supplied history when continuing without full taskState
    if (!input.taskState) {
      if (input.previousActions) {
        state = { ...state, previousActions: input.previousActions };
      }
      if (input.actionResults) {
        state = { ...state, actionResults: input.actionResults };
      }
      if (typeof input.iteration === "number") {
        state = { ...state, iteration: input.iteration };
      }
    }

    state = updateScreenshot(state, screenshot);
    state = setTaskStatus(state, "running");

    // --- Loop protection: max iterations ---
    if (state.iteration >= this.config.maxIterations) {
      const response = failResponse(
        `Maximum iterations (${this.config.maxIterations}) reached without completing the task.`,
      );
      state = setTaskError(state, response.message);
      return { taskState: state, response };
    }

    // --- Loop protection: repeated failed / identical actions ---
    const failedRepeats = countConsecutiveFailedRepeats(state.actionResults);
    if (failedRepeats.count >= this.config.maxSameActionRetries) {
      const response: AiPlanResponse = {
        status: "NEEDS_USER_INPUT",
        reasoning_summary:
          "Same action failed repeatedly; need user guidance.",
        actions: [
          {
            type: "ASK_USER",
            params: {
              question:
                "I keep failing the same action. How should I proceed?",
              reason: `Repeated unsuccessful action: ${failedRepeats.fingerprint}`,
            },
          },
        ],
        message:
          "Stuck repeating an unsuccessful action. Please provide guidance.",
      };
      state = recordPlannedActions(state, response.actions, "needs_user_input");
      return { taskState: state, response };
    }

    const sameActions = countConsecutiveSameActions(state.previousActions);
    if (sameActions.count >= this.config.maxSameActionRetries + 1) {
      const response = failResponse(
        `Detected action loop (${sameActions.fingerprint}). Aborting to prevent infinite retries.`,
      );
      state = setTaskError(state, response.message);
      return { taskState: state, response };
    }

    // --- Vision planning ---
    let rawPlan: AiPlanResponse;
    try {
      rawPlan = await planWithVision({
        provider: this.provider,
        model: this.config.model,
        screenshot,
        historySummary: summarizeHistoryForPrompt(state),
        iteration: state.iteration,
        maxIterations: this.config.maxIterations,
        userReply: input.userReply,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown vision planning error";
      const response = failResponse(`AI planning failed: ${message}`);
      state = setTaskError(state, response.message);
      return { taskState: state, response };
    }

    // Re-validate (defense in depth)
    const planParse = AiPlanResponseSchema.safeParse(rawPlan);
    if (!planParse.success) {
      const response = failResponse(
        `Invalid AI plan schema: ${planParse.error.message}`,
      );
      state = setTaskError(state, response.message);
      return { taskState: state, response };
    }

    let plan: AiPlanResponse = planParse.data as AiPlanResponse;

    // --- Safety layer ---
    const safety = validateActionSafety(plan.actions, screenshot, {
      userInstruction: state.userInstruction,
    });

    if (!safety.ok) {
      const hardBlocked = safety.violations.some((v) => !v.requiresConfirmation);
      if (hardBlocked && !safety.askUserAction) {
        const response = failResponse(
          `Safety violation: ${safety.violations.map((v) => v.message).join("; ")}`,
        );
        state = setTaskError(state, response.message);
        return { taskState: state, response };
      }

      if (safety.askUserAction) {
        const ask = safety.askUserAction;
        plan = {
          status: "NEEDS_USER_INPUT",
          reasoning_summary:
            "Action blocked by safety policy; user confirmation required.",
          actions: [ask],
          message:
            ask.type === "ASK_USER"
              ? ask.params.question
              : "Please confirm before continuing.",
        };
      } else {
        plan = {
          ...plan,
          actions: safety.safeActions,
        };
      }
    }

    // Normalize status vs terminal actions
    plan = normalizePlanStatus(plan);

    // Soft loop check — identical successful-looking repeats near the limit
    if (
      plan.actions.length > 0 &&
      sameActions.fingerprint &&
      sameActions.count >= 2
    ) {
      const proposedSame = plan.actions.every(
        (a) => actionFingerprint(a) === sameActions.fingerprint,
      );
      if (proposedSame) {
        plan = {
          status: "NEEDS_USER_INPUT",
          reasoning_summary: "Avoiding repeated identical action.",
          actions: [
            {
              type: "ASK_USER",
              params: {
                question:
                  "I am about to repeat the same action. Should I continue or try a different approach?",
                reason: `Potential loop: ${sameActions.fingerprint}`,
              },
            },
          ],
          message: "Potential action loop detected. Awaiting user input.",
        };
      }
    }

    const taskStatus =
      plan.status === "COMPLETED"
        ? "completed"
        : plan.status === "NEEDS_USER_INPUT"
          ? "needs_user_input"
          : plan.status === "FAILED"
            ? "failed"
            : "running";

    state = recordPlannedActions(state, plan.actions, taskStatus);
    if (plan.status === "FAILED") {
      state = { ...state, error: plan.message };
    }

    return { taskState: state, response: plan };
  }
}

function failResponse(message: string): AiPlanResponse {
  return {
    status: "FAILED",
    reasoning_summary: "Planning aborted.",
    actions: [],
    message,
  };
}

function normalizePlanStatus(plan: AiPlanResponse): AiPlanResponse {
  const hasDone = plan.actions.some((a) => a.type === "DONE");
  const hasAsk = plan.actions.some((a) => a.type === "ASK_USER");

  if (hasDone) {
    return {
      ...plan,
      status: "COMPLETED",
      actions: ensureTerminalDone(plan.actions),
    };
  }

  if (hasAsk || plan.status === "NEEDS_USER_INPUT") {
    return {
      ...plan,
      status: "NEEDS_USER_INPUT",
    };
  }

  if (plan.status === "FAILED") {
    return plan;
  }

  if (plan.actions.length === 0) {
    return {
      ...plan,
      status: "FAILED",
      message: plan.message || "Model returned no actions.",
      reasoning_summary: "Empty action list.",
    };
  }

  return {
    ...plan,
    status: "ACTION_REQUIRED",
  };
}

function ensureTerminalDone(actions: ComputerAction[]): ComputerAction[] {
  const withoutTrailingNoise = actions.filter(
    (a, idx) => !(a.type === "DONE" && idx < actions.length - 1),
  );
  const last = withoutTrailingNoise[withoutTrailingNoise.length - 1];
  if (last?.type === "DONE") return withoutTrailingNoise;
  return [
    ...withoutTrailingNoise.filter((a) => a.type !== "DONE"),
    { type: "DONE", params: { summary: "Task completed" } },
  ];
}

/**
 * Convenience function for backends that prefer a functional API.
 */
export async function planNextAction(
  input: PlanNextActionInput,
  options?: OrchestratorOptions,
): Promise<PlanNextActionResult> {
  const orchestrator = new Orchestrator(options);
  return orchestrator.planNextAction(input);
}
