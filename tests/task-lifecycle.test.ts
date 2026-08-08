import { describe, expect, it } from "vitest";
import { inferExecutionMode } from "../src/execution/mode.js";
import {
  decideAfterActionBatch,
  isTerminalTaskStatus,
  looksLikeFakeUserApproval,
  shouldReplanOnNonExecutablePlan,
} from "../src/execution/lifecycle.js";
import { Orchestrator } from "../src/orchestrator/index.js";
import { setTaskStatus } from "../src/memory/index.js";
import type {
  AiCompletionRequest,
  AiCompletionResponse,
  AiProvider,
  Screenshot,
} from "../src/types/index.js";

const tinyPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const screenshot: Screenshot = {
  width: 1920,
  height: 1080,
  image: tinyPng,
};

function countingProvider(plans: unknown[]): AiProvider & { calls: number } {
  const provider = {
    name: "mock",
    calls: 0,
    async complete(_req: AiCompletionRequest): Promise<AiCompletionResponse> {
      const plan = plans[Math.min(provider.calls, plans.length - 1)];
      provider.calls += 1;
      return {
        content: typeof plan === "string" ? plan : JSON.stringify(plan),
        model: "mock-model",
      };
    },
  };
  return provider;
}

describe("execution mode inference", () => {
  it("classifies Click refresh as single_action", () => {
    expect(inferExecutionMode("Click refresh")).toBe("single_action");
  });

  it("classifies Open Chrome as single_action", () => {
    expect(inferExecutionMode("Open Chrome")).toBe("single_action");
  });

  it("classifies Click the Settings button as single_action", () => {
    expect(inferExecutionMode("Click the Settings button")).toBe(
      "single_action",
    );
  });

  it("classifies Open Chrome and go to youtube.com as multi_step", () => {
    expect(inferExecutionMode("Open Chrome and go to youtube.com")).toBe(
      "multi_step",
    );
  });

  it("classifies Open VS Code, create a file, and type hello as multi_step", () => {
    expect(
      inferExecutionMode("Open VS Code, create a file, and type hello"),
    ).toBe("multi_step");
  });
});

describe("task lifecycle boundaries", () => {
  it("Test 1: Click refresh → single plan, complete after success (no replan)", () => {
    expect(inferExecutionMode("Click refresh")).toBe("single_action");
    const decision = decideAfterActionBatch({
      mode: "single_action",
      allSucceeded: true,
      taskStatus: "RUNNING",
    });
    expect(decision).toEqual({
      kind: "complete",
      summary: "Action completed successfully",
    });
    expect(
      shouldReplanOnNonExecutablePlan({
        mode: "single_action",
        status: "ACTION_REQUIRED",
        hasDone: false,
      }),
    ).toBe(false);
  });

  it("Test 2: Open Chrome → single_action completes after one success", () => {
    expect(inferExecutionMode("Open Chrome")).toBe("single_action");
    const decision = decideAfterActionBatch({
      mode: "single_action",
      allSucceeded: true,
      taskStatus: "RUNNING",
    });
    expect(decision.kind).toBe("complete");
  });

  it("Test 3: multi_step allows replan until COMPLETED", () => {
    expect(inferExecutionMode("Open Chrome and go to youtube.com")).toBe(
      "multi_step",
    );
    expect(
      decideAfterActionBatch({
        mode: "multi_step",
        allSucceeded: true,
        taskStatus: "RUNNING",
      }).kind,
    ).toBe("replan");
    expect(
      shouldReplanOnNonExecutablePlan({
        mode: "multi_step",
        status: "ACTION_REQUIRED",
        hasDone: false,
      }),
    ).toBe(true);
  });

  it("Test 4: NEEDS_USER_INPUT maps to WAITING_FOR_USER with no auto actions", () => {
    expect(
      looksLikeFakeUserApproval({
        message: "Clicking 'Approve'...",
        actions: [{ type: "CLICK", params: { x: 10, y: 10, button: "LEFT" } }],
      }),
    ).toBe(true);
    expect(
      shouldReplanOnNonExecutablePlan({
        mode: "single_action",
        status: "NEEDS_USER_INPUT",
        hasDone: false,
      }),
    ).toBe(false);
  });

  it("Test 5: COMPLETED is terminal — no further planning", () => {
    expect(isTerminalTaskStatus("COMPLETED")).toBe(true);
    expect(
      decideAfterActionBatch({
        mode: "multi_step",
        allSucceeded: true,
        taskStatus: "COMPLETED",
      }).kind,
    ).toBe("noop");
  });
});

describe("orchestrator single-shot behavior", () => {
  it("Test 1: Click refresh produces exactly one AI call for one plan", async () => {
    const provider = countingProvider([
      {
        status: "ACTION_REQUIRED",
        reasoning_summary: "Refresh button is visible top-left.",
        actions: [
          { type: "CLICK", params: { x: 40, y: 40, button: "LEFT" } },
        ],
        message: "Clicking refresh.",
      },
    ]);

    const orchestrator = new Orchestrator({
      provider,
      config: {
        maxIterations: 30,
        maxSameActionRetries: 3,
        openRouterApiKey: "unused",
      },
    });

    const result = await orchestrator.planNextAction({
      userInstruction: "Click refresh",
      screenshot,
    });

    expect(provider.calls).toBe(1);
    expect(result.executionMode).toBe("single_action");
    expect(result.response.status).toBe("ACTION_REQUIRED");
    expect(result.response.actions).toHaveLength(1);
    expect(result.response.actions[0]?.type).toBe("CLICK");

    // After success, lifecycle says complete — caller must not call plan again
    const after = decideAfterActionBatch({
      mode: result.executionMode,
      allSucceeded: true,
      taskStatus: "RUNNING",
    });
    expect(after.kind).toBe("complete");
  });

  it("Test 2: Open Chrome plans OPEN_APP once in single_action mode", async () => {
    const provider = countingProvider([
      {
        status: "ACTION_REQUIRED",
        reasoning_summary: "Chrome is not open.",
        actions: [{ type: "OPEN_APP", params: { app: "Google Chrome" } }],
        message: "Opening Chrome.",
      },
    ]);

    const orchestrator = new Orchestrator({
      provider,
      config: {
        maxIterations: 30,
        maxSameActionRetries: 3,
        openRouterApiKey: "unused",
      },
    });

    const result = await orchestrator.planNextAction({
      userInstruction: "Open Chrome",
      screenshot,
    });

    expect(provider.calls).toBe(1);
    expect(result.executionMode).toBe("single_action");
    expect(result.response.actions[0]?.type).toBe("OPEN_APP");
  });

  it("Test 3: multi_step allows multiple planning iterations", async () => {
    const provider = countingProvider([
      {
        status: "ACTION_REQUIRED",
        reasoning_summary: "Opening Chrome.",
        actions: [{ type: "OPEN_APP", params: { app: "Google Chrome" } }],
        message: "Opening Chrome.",
      },
      {
        status: "ACTION_REQUIRED",
        reasoning_summary: "Typing URL.",
        actions: [{ type: "TYPE_TEXT", params: { text: "youtube.com" } }],
        message: "Typing youtube.com.",
      },
      {
        status: "COMPLETED",
        reasoning_summary: "YouTube is open.",
        actions: [{ type: "DONE", params: { summary: "Opened YouTube" } }],
        message: "Done.",
      },
    ]);

    const orchestrator = new Orchestrator({
      provider,
      config: {
        maxIterations: 30,
        maxSameActionRetries: 3,
        openRouterApiKey: "unused",
      },
    });

    const instruction = "Open Chrome and go to youtube.com";
    let { taskState, response, executionMode } =
      await orchestrator.planNextAction({
        userInstruction: instruction,
        screenshot,
      });
    expect(executionMode).toBe("multi_step");
    expect(response.actions[0]?.type).toBe("OPEN_APP");

    ({ taskState, response } = await orchestrator.planNextAction({
      userInstruction: instruction,
      screenshot,
      taskState,
    }));
    expect(response.actions[0]?.type).toBe("TYPE_TEXT");

    ({ taskState, response } = await orchestrator.planNextAction({
      userInstruction: instruction,
      screenshot,
      taskState,
    }));
    expect(response.status).toBe("COMPLETED");
    expect(provider.calls).toBe(3);
  });

  it("Test 4: NEEDS_USER_INPUT does not invent approval clicks", async () => {
    const provider = countingProvider([
      {
        status: "ACTION_REQUIRED",
        reasoning_summary: "Acknowledging user approval...",
        actions: [
          { type: "CLICK", params: { x: 100, y: 200, button: "LEFT" } },
        ],
        message: "Clicking 'Approve'...",
      },
    ]);

    const orchestrator = new Orchestrator({
      provider,
      config: {
        maxIterations: 30,
        maxSameActionRetries: 3,
        openRouterApiKey: "unused",
      },
    });

    const result = await orchestrator.planNextAction({
      userInstruction: "Click the OK button in the dialog",
      screenshot,
    });

    expect(result.response.status).toBe("NEEDS_USER_INPUT");
    expect(result.response.actions.every((a) => a.type === "ASK_USER")).toBe(
      true,
    );
  });

  it("Test 5: COMPLETED refuses further AI planning", async () => {
    const provider = countingProvider([
      {
        status: "COMPLETED",
        reasoning_summary: "Already done.",
        actions: [{ type: "DONE", params: { summary: "Done" } }],
        message: "Done.",
      },
      {
        status: "ACTION_REQUIRED",
        reasoning_summary: "Should not run",
        actions: [{ type: "CLICK", params: { x: 1, y: 1, button: "LEFT" } }],
        message: "click",
      },
    ]);

    const orchestrator = new Orchestrator({
      provider,
      config: {
        maxIterations: 30,
        maxSameActionRetries: 3,
        openRouterApiKey: "unused",
      },
    });

    const first = await orchestrator.planNextAction({
      userInstruction: "Click refresh",
      screenshot,
    });
    expect(first.response.status).toBe("COMPLETED");
    expect(provider.calls).toBe(1);

    const completedState = setTaskStatus(first.taskState, "completed");
    const second = await orchestrator.planNextAction({
      userInstruction: "Click refresh",
      screenshot,
      taskState: completedState,
    });

    expect(second.response.status).toBe("COMPLETED");
    expect(provider.calls).toBe(1); // no additional AI call
  });

  it("Test 6: duplicate planning on terminal state is a no-op", async () => {
    const provider = countingProvider([
      {
        status: "ACTION_REQUIRED",
        reasoning_summary: "click",
        actions: [
          { type: "CLICK", params: { x: 10, y: 10, button: "LEFT" } },
        ],
        message: "click",
      },
    ]);

    const orchestrator = new Orchestrator({
      provider,
      config: {
        maxIterations: 30,
        maxSameActionRetries: 3,
        openRouterApiKey: "unused",
      },
    });

    const planned = await orchestrator.planNextAction({
      userInstruction: "Click refresh",
      screenshot,
    });
    expect(provider.calls).toBe(1);

    // Simulate task completed after action — second plan must not call AI
    const terminal = setTaskStatus(planned.taskState, "completed");
    const again = await orchestrator.planNextAction({
      userInstruction: "Click refresh",
      screenshot,
      taskState: terminal,
    });
    expect(provider.calls).toBe(1);
    expect(again.response.status).toBe("COMPLETED");
  });
});
