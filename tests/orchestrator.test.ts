import { describe, expect, it } from "vitest";
import { Orchestrator, planNextAction } from "../src/orchestrator/index.js";
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
    name: "mock",
    async complete(_req: AiCompletionRequest): Promise<AiCompletionResponse> {
      if (options?.fail) {
        throw new Error("upstream down");
      }
      return {
        content: typeof plan === "string" ? plan : JSON.stringify(plan),
        model: "mock-model",
      };
    },
  };
}

describe("orchestrator.planNextAction", () => {
  it("returns validated OPEN_APP action from vision plan (first action)", async () => {
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
    expect(result.taskState.currentScreenshot?.image).toBe("[stripped]");
  });

  it("continues with taskState after recordActionResults", async () => {
    const plans = [
      {
        status: "ACTION_REQUIRED",
        reasoning_summary: "Address bar ready.",
        actions: [{ type: "TYPE_TEXT", params: { text: "youtube.com" } }],
        message: "Typing URL.",
      },
      {
        status: "ACTION_REQUIRED",
        reasoning_summary: "URL typed; press Enter.",
        actions: [{ type: "KEY_PRESS", params: { key: "Enter" } }],
        message: "Submitting URL.",
      },
    ];
    let call = 0;
    const provider: AiProvider = {
      name: "mock",
      async complete() {
        const plan = plans[Math.min(call, plans.length - 1)];
        call += 1;
        return { content: JSON.stringify(plan), model: "mock" };
      },
    };

    const orchestrator = new Orchestrator({
      provider,
      config: {
        maxIterations: 30,
        maxSameActionRetries: 3,
        openRouterApiKey: "unused",
      },
    });

    // Multi-step so a second plan is allowed after a successful first action
    let { taskState, response } = await orchestrator.planNextAction({
      userInstruction: "Open Chrome and go to youtube.com",
      screenshot,
      executionMode: "multi_step",
    });

    expect(response.actions[0]?.type).toBe("TYPE_TEXT");

    taskState = recordActionResults(taskState, [
      {
        action: response.actions[0],
        success: true,
        executedAt: new Date().toISOString(),
      },
    ]);

    ({ taskState, response } = await orchestrator.planNextAction({
      userInstruction: taskState.userInstruction,
      screenshot,
      taskState,
    }));

    expect(response.status).toBe("ACTION_REQUIRED");
    expect(response.actions[0]?.type).toBe("KEY_PRESS");
    expect(taskState.iteration).toBe(2);
    expect(taskState.actionResults).toHaveLength(1);
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
        actions: [
          { type: "CLICK", params: { x: 99999, y: 10, button: "LEFT" } },
        ],
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
    expect(result.response.message).toMatch(
      /Safety violation|out of bounds|COORDINATE/i,
    );
  });

  it("escalates destructive instructions to ASK_USER", async () => {
    const orchestrator = new Orchestrator({
      provider: mockProvider({
        status: "ACTION_REQUIRED",
        reasoning_summary: "delete files",
        actions: [
          { type: "CLICK", params: { x: 100, y: 100, button: "LEFT" } },
        ],
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

  it("returns FAILED for malformed model JSON", async () => {
    const orchestrator = new Orchestrator({
      provider: mockProvider("definitely not json {{{"),
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
    expect(result.response.message).toMatch(/non-JSON|AI planning failed/i);
  });

  it("supports functional planNextAction API", async () => {
    const result = await planNextAction(
      {
        userInstruction: "Open Chrome",
        screenshot,
      },
      {
        provider: mockProvider({
          status: "ACTION_REQUIRED",
          reasoning_summary: "Opening Chrome.",
          actions: [{ type: "OPEN_APP", params: { app: "Chrome" } }],
          message: "Opening Chrome.",
        }),
        config: { openRouterApiKey: "unused", model: "mock" },
      },
    );
    expect(result.response.actions[0]?.type).toBe("OPEN_APP");
  });
});
