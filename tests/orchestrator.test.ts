import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator/index.js";
import type {
  AiCompletionRequest,
  AiCompletionResponse,
  AiProvider,
  ComputerAction,
  Screenshot,
} from "../src/types/index.js";
import { recordActionResults } from "../src/memory/index.js";

const tinyPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const screenshot: Screenshot = {
  width: 1920,
  height: 1080,
  image: tinyPng,
};

function mockProvider(
  plan: unknown,
  options?: { fail?: boolean },
): AiProvider {
  return {
    name: "openrouter",
    async complete(_req: AiCompletionRequest): Promise<AiCompletionResponse> {
      if (options?.fail) {
        throw new Error("upstream down");
      }
      return {
        content: JSON.stringify(plan),
        model: "mock-model",
      };
    },
  };
}

describe("orchestrator.planNextAction", () => {
  it("returns validated OPEN_APP action from vision plan", async () => {
    const orchestrator = new Orchestrator({
      provider: mockProvider({
        status: "ACTION_REQUIRED",
        reasoning_summary: "Chrome is not visible; opening it.",
        actions: [{ type: "OPEN_APP", params: { app: "Google Chrome" } }],
        message: "Opening Google Chrome.",
      }),
      config: {
        provider: "openrouter",
        model: "mock",
        maxIterations: 30,
        maxSameActionRetries: 3,
        openRouterApiKey: "unused",
      },
    });

    const result = await orchestrator.planNextAction({
      userInstruction: "Open Chrome and go to youtube.com",
      screenshot,
    });

    expect(result.response.status).toBe("ACTION_REQUIRED");
    expect(result.response.actions[0]).toEqual({
      type: "OPEN_APP",
      params: { app: "Google Chrome" },
    });
    expect(result.taskState.iteration).toBe(1);
    expect(result.taskState.status).toBe("running");
  });

  it("marks COMPLETED when DONE is returned", async () => {
    const orchestrator = new Orchestrator({
      provider: mockProvider({
        status: "ACTION_REQUIRED",
        reasoning_summary: "YouTube is open.",
        actions: [{ type: "DONE", params: { summary: "Opened youtube.com" } }],
        message: "Done.",
      }),
      config: {
        maxIterations: 30,
        maxSameActionRetries: 3,
        openRouterApiKey: "unused",
      },
    });

    const result = await orchestrator.planNextAction({
      userInstruction: "Open youtube.com",
      screenshot,
    });

    expect(result.response.status).toBe("COMPLETED");
    expect(result.taskState.status).toBe("completed");
  });

  it("fails when max iterations reached", async () => {
    const orchestrator = new Orchestrator({
      provider: mockProvider({
        status: "ACTION_REQUIRED",
        reasoning_summary: "continue",
        actions: [{ type: "WAIT", params: { ms: 100 } }],
        message: "waiting",
      }),
      config: {
        maxIterations: 2,
        maxSameActionRetries: 3,
        openRouterApiKey: "unused",
      },
    });

    const result = await orchestrator.planNextAction({
      userInstruction: "do something",
      screenshot,
      iteration: 2,
      previousActions: [
        { type: "WAIT", params: { ms: 100 } },
        { type: "WAIT", params: { ms: 200 } },
      ],
    });

    expect(result.response.status).toBe("FAILED");
    expect(result.response.message).toMatch(/Maximum iterations/);
  });

  it("asks user after repeated failed identical actions", async () => {
    const click: ComputerAction = {
      type: "CLICK",
      params: { x: 50, y: 50, button: "LEFT" },
    };

    const orchestrator = new Orchestrator({
      provider: mockProvider({
        status: "ACTION_REQUIRED",
        reasoning_summary: "retry",
        actions: [click],
        message: "retrying",
      }),
      config: {
        maxIterations: 30,
        maxSameActionRetries: 3,
        openRouterApiKey: "unused",
      },
    });

    let state = (
      await orchestrator.planNextAction({
        userInstruction: "click the button",
        screenshot,
      })
    ).taskState;

    // Simulate three failed executions of the same action
    state = recordActionResults(state, [
      {
        action: click,
        success: false,
        error: "no effect",
        executedAt: new Date().toISOString(),
      },
      {
        action: click,
        success: false,
        error: "no effect",
        executedAt: new Date().toISOString(),
      },
      {
        action: click,
        success: false,
        error: "no effect",
        executedAt: new Date().toISOString(),
      },
    ]);

    const result = await orchestrator.planNextAction({
      userInstruction: "click the button",
      screenshot,
      taskState: state,
    });

    expect(result.response.status).toBe("NEEDS_USER_INPUT");
    expect(result.response.actions[0]?.type).toBe("ASK_USER");
  });

  it("blocks out-of-bounds coordinates via safety", async () => {
    const orchestrator = new Orchestrator({
      provider: mockProvider({
        status: "ACTION_REQUIRED",
        reasoning_summary: "click",
        actions: [{ type: "CLICK", params: { x: 99999, y: 10, button: "LEFT" } }],
        message: "clicking",
      }),
      config: {
        maxIterations: 30,
        maxSameActionRetries: 3,
        openRouterApiKey: "unused",
      },
    });

    const result = await orchestrator.planNextAction({
      userInstruction: "click something",
      screenshot,
    });

    expect(result.response.status).toBe("FAILED");
    expect(result.response.message).toMatch(/Safety violation|out of bounds|COORDINATE/i);
  });

  it("escalates destructive instructions to ASK_USER", async () => {
    const orchestrator = new Orchestrator({
      provider: mockProvider({
        status: "ACTION_REQUIRED",
        reasoning_summary: "delete files",
        actions: [{ type: "CLICK", params: { x: 100, y: 100, button: "LEFT" } }],
        message: "deleting",
      }),
      config: {
        maxIterations: 30,
        maxSameActionRetries: 3,
        openRouterApiKey: "unused",
      },
    });

    const result = await orchestrator.planNextAction({
      userInstruction: "Delete all important files from my Documents folder",
      screenshot,
    });

    expect(result.response.status).toBe("NEEDS_USER_INPUT");
    expect(result.response.actions[0]?.type).toBe("ASK_USER");
  });

  it("returns FAILED when the provider throws", async () => {
    const orchestrator = new Orchestrator({
      provider: mockProvider({}, { fail: true }),
      config: {
        maxIterations: 30,
        maxSameActionRetries: 3,
        openRouterApiKey: "unused",
      },
    });

    const result = await orchestrator.planNextAction({
      userInstruction: "open chrome",
      screenshot,
    });

    expect(result.response.status).toBe("FAILED");
    expect(result.response.message).toMatch(/upstream down/);
  });
});
