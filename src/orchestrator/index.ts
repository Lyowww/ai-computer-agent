import type {
  ActionResult,
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
import { actionFingerprint, requiresCoordinates } from "../actions/index.js";
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
import { inferExecutionMode } from "../execution/mode.js";
import {
  looksLikeFakeUserApproval,
  toNeedsUserInputPlan,
} from "../execution/lifecycle.js";
import { nowIso } from "../utils/index.js";
import {
  withAlignedDimensions,
  formatAiCoordinateLog,
} from "../localization/index.js";
import {
  classifyUserIntent,
  resolveContinuationInstruction,
  validateActionAgainstIntent,
  validateOpenAppAction,
  type ClassifiedIntent,
} from "../intent/index.js";

function taskLog(taskId: string, message: string, extra?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      level: "INFO",
      taskId,
      message,
      ...extra,
    }),
  );
}

function boundaryLog(
  taskId: string,
  stage: string,
  extra?: Record<string, unknown>,
): void {
  console.log(
    JSON.stringify({
      level: "INFO",
      taskId,
      stage,
      ...extra,
    }),
  );
}

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

    const aligned = withAlignedDimensions(screenshotParse.data);
    const screenshot = aligned.screenshot;
    if (aligned.check.warning) {
      console.warn(
        JSON.stringify({
          level: "WARN",
          message: aligned.check.warning,
          metadata: {
            width: aligned.check.metadataWidth,
            height: aligned.check.metadataHeight,
          },
          image: { width: aligned.check.width, height: aligned.check.height },
        }),
      );
    }

    // Continuation ("again") → reuse prior identifiable instruction only
    const continuation = resolveContinuationInstruction(
      input.userInstruction,
      input.previousTaskInstruction,
    );
    if (continuation.unresolved) {
      const askPlan = toNeedsUserInputPlan(
        "I don't have a previous task to retry. What should I do?",
      );
      const state = createTaskState({
        taskId: input.taskId,
        userInstruction: input.userInstruction,
        screenshot,
        executionMode: "single_action",
      });
      boundaryLog(state.taskId, "USER_INTENT", {
        intent: "UNKNOWN",
        continuation: true,
        unresolved: true,
        instruction: input.userInstruction,
      });
      const recorded = recordPlannedActions(
        state,
        askPlan.actions,
        "needs_user_input",
      );
      return {
        taskState: recorded,
        response: askPlan,
        executionMode: "single_action",
      };
    }

    const userInstruction = continuation.instruction;
    const intent = classifyUserIntent(userInstruction);

    let state: TaskState =
      input.taskState ??
      createTaskState({
        taskId: input.taskId,
        userInstruction,
        screenshot,
        executionMode:
          input.executionMode ?? inferExecutionMode(userInstruction),
      });

    // If we rewrote a continuation onto a prior instruction, keep that as the task text.
    if (userInstruction !== state.userInstruction && !input.taskState) {
      state = { ...state, userInstruction };
    }

    boundaryLog(state.taskId, "USER_INSTRUCTION", {
      instruction: userInstruction,
      rawInstruction: input.userInstruction,
    });
    boundaryLog(state.taskId, "INTENT", {
      intent: intent.intent,
      scrollDirection: intent.scrollDirection,
      scrollAmount: intent.scrollAmount,
      targetLabel: intent.targetLabel ?? undefined,
      isContinuation:
        intent.isContinuation ||
        continuation.instruction !== input.userInstruction,
    });
    // Back-compat alias for existing log consumers
    boundaryLog(state.taskId, "USER_INTENT", {
      intent: intent.intent,
      instruction: userInstruction,
      scrollDirection: intent.scrollDirection,
      scrollAmount: intent.scrollAmount,
      targetLabel: intent.targetLabel ?? undefined,
      isContinuation:
        intent.isContinuation ||
        continuation.instruction !== input.userInstruction,
    });

    taskLog(state.taskId, `User: ${state.userInstruction}`, {
      executionMode: state.executionMode,
      iteration: state.iteration,
      intent: intent.intent,
    });
    taskLog(
      state.taskId,
      `Screenshot: ${screenshot.width}x${screenshot.height}`,
      {
        corrected: aligned.check.corrected,
        measured: aligned.check.measured,
      },
    );

    // Hard boundary: never plan for terminal tasks
    if (
      state.status === "completed" ||
      state.status === "failed" ||
      state.status === "cancelled"
    ) {
      const response = failResponse(
        `Task is already ${state.status}; refusing further planning.`,
      );
      return {
        taskState: state,
        response: {
          ...response,
          status: state.status === "completed" ? "COMPLETED" : "FAILED",
        },
        executionMode: state.executionMode,
      };
    }

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
      if (input.executionMode) {
        state = { ...state, executionMode: input.executionMode };
      }
    }

    // Map previousActions[].success into actionResults when callers only send previousActions
    state = ensureActionResultsFromPrevious(state, input);

    state = updateScreenshot(state, screenshot);
    state = setTaskStatus(state, "running");

    // Single-action tasks: never burn retries inventing alternate clicks
    const sameActionLimit =
      state.executionMode === "single_action"
        ? 1
        : this.config.maxSameActionRetries;

    // --- Loop protection: max iterations ---
    if (state.iteration >= this.config.maxIterations) {
      const response = failResponse(
        `Maximum iterations (${this.config.maxIterations}) reached without completing the task.`,
      );
      state = setTaskError(state, response.message);
      return {
        taskState: state,
        response,
        executionMode: state.executionMode,
      };
    }

    // --- Loop protection: repeated failed / identical actions ---
    const failedRepeats = countConsecutiveFailedRepeats(state.actionResults);
    if (failedRepeats.count >= sameActionLimit) {
      const response: AiPlanResponse = {
        status: "NEEDS_USER_INPUT",
        reasoning_summary:
          "Same action failed; need user guidance rather than guessing again.",
        actions: [
          {
            type: "ASK_USER",
            params: {
              question:
                "I can't confidently identify the requested target. How should I proceed?",
              reason: `Unsuccessful action: ${failedRepeats.fingerprint}`,
            },
          },
        ],
        message:
          "I can't confidently identify the requested button in the current screen.",
      };
      state = recordPlannedActions(state, response.actions, "needs_user_input");
      return {
        taskState: state,
        response,
        executionMode: state.executionMode,
      };
    }

    const sameActions = countConsecutiveSameActions(state.previousActions);
    if (sameActions.count >= sameActionLimit + 1) {
      const response = failResponse(
        `Detected action loop (${sameActions.fingerprint}). Aborting to prevent infinite retries.`,
      );
      state = setTaskError(state, response.message);
      return {
        taskState: state,
        response,
        executionMode: state.executionMode,
      };
    }

    // Deterministic SCROLL / simple OPEN_APP — only for single_action clear intents
    if (
      state.executionMode === "single_action" &&
      state.previousActions.length === 0 &&
      (intent.intent === "SCROLL" ||
        (intent.intent === "OPEN_APP" && intent.targetLabel))
    ) {
      if (intent.intent === "SCROLL") {
        const deterministic = buildDeterministicScrollPlan(
          intent,
          userInstruction,
        );
        boundaryLog(state.taskId, "RAW_AI_RESPONSE", {
          source: "deterministic_intent",
          actions: deterministic.actions.map((a) => ({
            type: a.type,
            params: a.params,
          })),
        });
        boundaryLog(state.taskId, "MODEL_RESPONSE", {
          source: "deterministic_intent",
          actions: deterministic.actions.map((a) => ({
            type: a.type,
            params: a.params,
          })),
        });
        boundaryLog(state.taskId, "NORMALIZED_ACTION", {
          actions: deterministic.actions.map((a) => ({
            type: a.type,
            params: a.params,
          })),
        });
        boundaryLog(state.taskId, "VALIDATED_ACTION", { result: "PASS" });
        boundaryLog(state.taskId, "BACKEND_ACTION", {
          status: deterministic.status,
          actions: deterministic.actions.map((a) => ({
            type: a.type,
            params: a.params,
          })),
        });
        state = recordPlannedActions(state, deterministic.actions, "running");
        taskLog(state.taskId, `AI status: ${deterministic.status}`, {
          actions: deterministic.actions.map((a) => a.type),
        });
        return {
          taskState: state,
          response: deterministic,
          executionMode: state.executionMode,
        };
      }

      // OPEN_APP — validate app name before emitting; never guess another action
      const openPlan = buildDeterministicOpenAppPlan(intent);
      const openAction = openPlan.actions[0];
      boundaryLog(state.taskId, "RAW_AI_RESPONSE", {
        source: "deterministic_intent",
        actions: openPlan.actions.map((a) => ({
          type: a.type,
          params: a.params,
        })),
      });
      boundaryLog(state.taskId, "NORMALIZED_ACTION", {
        actions: openPlan.actions.map((a) => ({
          type: a.type,
          params: a.params,
        })),
      });

      if (openAction) {
        const openCheck = validateOpenAppAction(openAction, userInstruction);
        if (!openCheck.ok) {
          boundaryLog(state.taskId, "VALIDATED_ACTION", {
            result: "REJECT",
            reason: openCheck.reason,
          });
          const askPlan: AiPlanResponse = {
            status: "NEEDS_USER_INPUT",
            reasoning_summary:
              "OPEN_APP failed validation; refusing to guess a UI click or substitute app.",
            actions: [
              {
                type: "ASK_USER",
                params: {
                  question:
                    openCheck.reason ??
                    "I could not identify a valid desktop application to open. Which app should I launch?",
                  reason: openCheck.reason,
                },
              },
            ],
            message:
              openCheck.reason ??
              "I could not identify a valid desktop application to open.",
          };
          boundaryLog(state.taskId, "BACKEND_ACTION", {
            status: askPlan.status,
            actions: askPlan.actions.map((a) => ({
              type: a.type,
              params: a.params,
            })),
          });
          state = recordPlannedActions(
            state,
            askPlan.actions,
            "needs_user_input",
          );
          return {
            taskState: state,
            response: askPlan,
            executionMode: state.executionMode,
          };
        }
      }

      boundaryLog(state.taskId, "MODEL_RESPONSE", {
        source: "deterministic_intent",
        actions: openPlan.actions.map((a) => ({
          type: a.type,
          params: a.params,
        })),
      });
      boundaryLog(state.taskId, "VALIDATED_ACTION", { result: "PASS" });
      boundaryLog(state.taskId, "BACKEND_ACTION", {
        status: openPlan.status,
        actions: openPlan.actions.map((a) => ({
          type: a.type,
          params: a.params,
        })),
      });
      state = recordPlannedActions(state, openPlan.actions, "running");
      taskLog(state.taskId, `AI status: ${openPlan.status}`, {
        actions: openPlan.actions.map((a) => a.type),
      });
      return {
        taskState: state,
        response: openPlan,
        executionMode: state.executionMode,
      };
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
        intent,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown vision planning error";
      const response = failResponse(`AI planning failed: ${message}`);
      state = setTaskError(state, response.message);
      return {
        taskState: state,
        response,
        executionMode: state.executionMode,
      };
    }

    boundaryLog(state.taskId, "RAW_AI_RESPONSE", {
      status: rawPlan.status,
      reasoning_summary: rawPlan.reasoning_summary,
      actions: rawPlan.actions.map((a) => ({
        type: a.type,
        params: a.params,
      })),
    });
    boundaryLog(state.taskId, "MODEL_RESPONSE", {
      status: rawPlan.status,
      reasoning_summary: rawPlan.reasoning_summary,
      actions: rawPlan.actions.map((a) => ({
        type: a.type,
        params: a.params,
      })),
    });

    // Re-validate (defense in depth)
    const planParse = AiPlanResponseSchema.safeParse(rawPlan);
    if (!planParse.success) {
      const response = failResponse(
        `Invalid AI plan schema: ${planParse.error.message}`,
      );
      state = setTaskError(state, response.message);
      return {
        taskState: state,
        response,
        executionMode: state.executionMode,
      };
    }

    let plan: AiPlanResponse = planParse.data as AiPlanResponse;

    boundaryLog(state.taskId, "NORMALIZED_ACTION", {
      actions: plan.actions.map((a) => ({ type: a.type, params: a.params })),
    });

    // --- Semantic intent validation (structured action is authoritative) ---
    const intentCheck = validateActionAgainstIntent(
      userInstruction,
      plan.actions,
      intent,
    );
    if (!intentCheck.ok) {
      boundaryLog(state.taskId, "VALIDATED_ACTION", {
        result: "REJECT",
        reason: intentCheck.reason,
      });
      plan = {
        status: "NEEDS_USER_INPUT",
        reasoning_summary:
          "Model action type did not match user intent; refusing to execute a substituted action.",
        actions: [
          {
            type: "ASK_USER",
            params: {
              question:
                intentCheck.reason ??
                "I could not match an action to your request without guessing. How should I proceed?",
              reason: intentCheck.reason,
            },
          },
        ],
        message:
          intentCheck.reason ??
          "I can't confidently identify the requested target in the current screen.",
      };
    } else {
      // --- Safety layer (bounds + spatial sanity + target label) ---
      const safety = validateActionSafety(plan.actions, screenshot, {
        userInstruction,
        intent: intent.intent,
      });

      if (!safety.ok) {
        const hardBlocked = safety.violations.some((v) => !v.requiresConfirmation);
        if (hardBlocked && !safety.askUserAction) {
          boundaryLog(state.taskId, "VALIDATED_ACTION", {
            result: "FAIL",
            violations: safety.violations,
          });
          const response = failResponse(
            `Safety violation: ${safety.violations.map((v) => v.message).join("; ")}`,
          );
          state = setTaskError(state, response.message);
          return {
            taskState: state,
            response,
            executionMode: state.executionMode,
          };
        }

        if (safety.askUserAction) {
          const ask = safety.askUserAction;
          plan = {
            status: "NEEDS_USER_INPUT",
            reasoning_summary:
              safety.violations.some((v) => v.code === "SPATIAL_CONSTRAINT_VIOLATION")
                ? "Proposed click contradicts the spatial language in the user instruction."
                : safety.violations.some(
                      (v) =>
                        v.code === "TARGET_LABEL_MISMATCH" ||
                        v.code === "TARGET_IDENTITY_MISSING" ||
                        v.code === "TARGET_CONFIDENCE_LOW",
                    )
                  ? "Requested target could not be confidently identified; refusing to click a substitute."
                  : "Action blocked by safety policy; user confirmation required.",
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

      boundaryLog(state.taskId, "VALIDATED_ACTION", {
        result: plan.status === "NEEDS_USER_INPUT" ? "NEEDS_USER_INPUT" : "PASS",
        actions: plan.actions.map((a) => a.type),
      });
    }

    // Block fake approval / dashboard self-driving
    if (
      looksLikeFakeUserApproval({
        message: plan.message,
        reasoning_summary: plan.reasoning_summary,
        actions: plan.actions,
      })
    ) {
      plan = toNeedsUserInputPlan(
        "I need your real confirmation to continue. Please reply here — I will not click Approve or type into the control UI.",
      );
    }

    // Normalize status vs terminal actions
    plan = normalizePlanStatus(plan);

    // Soft loop check — identical successful-looking repeats near the limit
    const softRepeatThreshold = state.executionMode === "single_action" ? 1 : 2;
    if (
      plan.actions.length > 0 &&
      sameActions.fingerprint &&
      sameActions.count >= softRepeatThreshold
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
                  "I can't confidently identify the requested button in the current screen. Should I try a different approach?",
                reason: `Potential loop: ${sameActions.fingerprint}`,
              },
            },
          ],
          message:
            "I can't confidently identify the requested button in the current screen.",
        };
      }
    }

    for (const action of plan.actions) {
      if (
        requiresCoordinates(action.type) &&
        "x" in action.params &&
        "y" in action.params
      ) {
        const label =
          "targetLabel" in action.params &&
          typeof action.params.targetLabel === "string"
            ? action.params.targetLabel
            : undefined;
        console.log(
          formatAiCoordinateLog({
            taskId: state.taskId,
            x: action.params.x as number,
            y: action.params.y as number,
            imageWidth: screenshot.width,
            imageHeight: screenshot.height,
            targetLabel: label,
          }),
        );
      }
    }

    boundaryLog(state.taskId, "BACKEND_ACTION", {
      status: plan.status,
      actions: plan.actions.map((a) => ({ type: a.type, params: a.params })),
    });

    taskLog(state.taskId, `AI status: ${plan.status}`, {
      actions: plan.actions.map((a) => a.type),
    });

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

    return {
      taskState: state,
      response: plan,
      executionMode: state.executionMode,
    };
  }
}

function buildDeterministicScrollPlan(
  intent: ClassifiedIntent,
  instruction: string,
): AiPlanResponse {
  const direction = intent.scrollDirection ?? "down";
  const amount = intent.scrollAmount ?? 5;
  return {
    status: "ACTION_REQUIRED",
    reasoning_summary: `User requested scroll (${direction}); emitting SCROLL action.`,
    actions: [
      {
        type: "SCROLL",
        params: { direction, amount },
      },
    ],
    message:
      direction === "down" && /\bbottom\b/i.test(instruction)
        ? "Scrolling down toward the bottom."
        : `Scrolling ${direction}.`,
  };
}

function buildDeterministicOpenAppPlan(intent: ClassifiedIntent): AiPlanResponse {
  const app = (intent.targetLabel ?? "Unknown").trim();
  return {
    status: "ACTION_REQUIRED",
    reasoning_summary: `User requested open app; emitting OPEN_APP for ${app}.`,
    actions: [{ type: "OPEN_APP", params: { app } }],
    message: `Opening ${app}.`,
  };
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
 * When HTTP callers send previousActions with a `success` flag but no actionResults,
 * materialize ActionResult entries so the model can see outcomes.
 */
function ensureActionResultsFromPrevious(
  state: TaskState,
  input: PlanNextActionInput,
): TaskState {
  if (input.actionResults && input.actionResults.length > 0) {
    return state;
  }
  if (!input.previousActions || input.previousActions.length === 0) {
    return state;
  }

  const withSuccess = input.previousActions as Array<
    ComputerAction & { success?: boolean; error?: string }
  >;
  if (!withSuccess.some((a) => typeof a.success === "boolean")) {
    return state;
  }

  const derived: ActionResult[] = withSuccess
    .filter((a) => typeof a.success === "boolean")
    .map((a) => ({
      action: {
        type: a.type,
        params: a.params,
      } as ComputerAction,
      success: Boolean(a.success),
      error: a.error,
      executedAt: nowIso(),
    }));

  if (derived.length === 0) return state;
  return { ...state, actionResults: derived };
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
