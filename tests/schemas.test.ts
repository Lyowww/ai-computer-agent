import { describe, expect, it } from "vitest";
import {
  ComputerActionSchema,
  AiPlanResponseSchema,
  ScreenshotSchema,
  normalizeRawAction,
  normalizeRawPlan,
} from "../src/schemas/index.js";
import {
  parseAction,
  tryParseAction,
  actionFingerprint,
  isSupportedActionType,
  hashTextFingerprint,
} from "../src/actions/index.js";
import { validateActionSafety } from "../src/safety/index.js";
import { planWithVision } from "../src/vision/index.js";
import type {
  AiCompletionRequest,
  AiCompletionResponse,
  AiProvider,
  Screenshot,
} from "../src/types/index.js";
import { Orchestrator } from "../src/orchestrator/index.js";

const screenshot: Screenshot = {
  width: 1280,
  height: 800,
  image: "not-a-real-png-payload-for-tests",
};

describe("action schemas", () => {
  it("parses CLICK actions", () => {
    const action = parseAction({
      type: "CLICK",
      params: { x: 100, y: 200, button: "LEFT" },
    });
    expect(action.type).toBe("CLICK");
    expect(action.params).toMatchObject({ x: 100, y: 200, button: "LEFT" });
  });

  it("normalizes flat model actions into params shape", () => {
    const action = parseAction({
      type: "CLICK",
      x: 500,
      y: 300,
      button: "left",
    });
    expect(action).toEqual({
      type: "CLICK",
      params: { x: 500, y: 300, button: "LEFT" },
    });
  });

  it("parses TYPE_TEXT, OPEN_APP, and SCROLL", () => {
    expect(
      parseAction({ type: "TYPE_TEXT", params: { text: "Hello world" } }).type,
    ).toBe("TYPE_TEXT");
    expect(
      parseAction({ type: "OPEN_APP", params: { app: "Google Chrome" } }).type,
    ).toBe("OPEN_APP");
    expect(
      parseAction({
        type: "SCROLL",
        params: { direction: "down", amount: 5 },
      }).type,
    ).toBe("SCROLL");
  });

  it("rejects unknown action types", () => {
    expect(
      ComputerActionSchema.safeParse({
        type: "RUN_SHELL",
        params: { command: "rm -rf /" },
      }).success,
    ).toBe(false);
    expect(tryParseAction({ type: "EXEC", params: {} })).toBeNull();
    expect(isSupportedActionType("RUN_SHELL")).toBe(false);
  });

  it("rejects TYPE_TEXT with empty string", () => {
    expect(
      ComputerActionSchema.safeParse({
        type: "TYPE_TEXT",
        params: { text: "" },
      }).success,
    ).toBe(false);
  });

  it("rejects invalid WAIT limits", () => {
    expect(
      ComputerActionSchema.safeParse({
        type: "WAIT",
        params: { ms: 120_000 },
      }).success,
    ).toBe(false);
  });

  it("validates full AI plan responses", () => {
    const plan = AiPlanResponseSchema.parse({
      status: "ACTION_REQUIRED",
      reasoning_summary: "Chrome not open; launching it.",
      actions: [{ type: "OPEN_APP", params: { app: "Google Chrome" } }],
      message: "Opening Google Chrome.",
    });
    expect(plan.actions).toHaveLength(1);
  });

  it("accepts flat actions inside a plan", () => {
    const plan = AiPlanResponseSchema.parse({
      status: "ACTION_REQUIRED",
      reasoning_summary: "Button visible.",
      actions: [{ type: "CLICK", x: 10, y: 20, button: "left" }],
      message: "Clicking.",
    });
    expect(plan.actions[0]).toEqual({
      type: "CLICK",
      params: { x: 10, y: 20, button: "LEFT" },
    });
  });

  it("rejects malformed plan responses", () => {
    expect(
      AiPlanResponseSchema.safeParse({
        status: "NOPE",
        reasoning_summary: "x",
        actions: [],
        message: "y",
      }).success,
    ).toBe(false);
  });

  it("validates screenshots", () => {
    const shot = ScreenshotSchema.parse({
      width: 1920,
      height: 1080,
      image: "base64data",
    });
    expect(shot.width).toBe(1920);
  });

  it("builds deterministic fingerprints", () => {
    const a = parseAction({
      type: "CLICK",
      params: { x: 500, y: 300, button: "LEFT" },
    });
    const b = parseAction({
      type: "CLICK",
      params: { button: "left", y: 300, x: 500 },
    });
    expect(actionFingerprint(a)).toBe("CLICK:500:300:left");
    expect(actionFingerprint(a)).toBe(actionFingerprint(b));

    const typed = parseAction({
      type: "TYPE_TEXT",
      params: { text: "secret password" },
    });
    expect(actionFingerprint(typed)).toBe(
      `TYPE_TEXT:${hashTextFingerprint("secret password")}`,
    );
    expect(actionFingerprint(typed)).not.toContain("secret");

    expect(
      actionFingerprint(
        parseAction({ type: "HOTKEY", params: { keys: ["CTRL", "L"] } }),
      ),
    ).toBe("HOTKEY:ctrl+l");
    expect(
      actionFingerprint(
        parseAction({ type: "OPEN_APP", params: { app: "Chrome" } }),
      ),
    ).toBe("OPEN_APP:chrome");
  });

  it("normalizeRawAction leaves unknown types alone", () => {
    const raw = { type: "RUN_SHELL", command: "ls" };
    expect(normalizeRawAction(raw)).toEqual(raw);
  });

  it("accepts ACTION_REQUIRED plans that omit message (defaults to empty string)", () => {
    const plan = AiPlanResponseSchema.parse({
      status: "ACTION_REQUIRED",
      reasoning_summary: "Open a new browser tab.",
      actions: [
        {
          type: "HOTKEY",
          params: {
            keys: ["META", "T"],
          },
        },
      ],
    });
    expect(plan.message).toBe("");
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.type).toBe("HOTKEY");
  });

  it("accepts plans that omit reasoning_summary (defaults to empty string)", () => {
    const plan = AiPlanResponseSchema.parse({
      status: "ACTION_REQUIRED",
      actions: [
        {
          type: "HOTKEY",
          params: { keys: ["META", "T"] },
        },
      ],
      message: "Opening a new tab.",
    });
    expect(plan.reasoning_summary).toBe("");
  });

  it("normalizeRawPlan defaults message/reasoning_summary but does not invent actions", () => {
    const withActions = normalizeRawPlan({
      status: "ACTION_REQUIRED",
      actions: [{ type: "CLICK", x: 500, y: 100 }],
    }) as Record<string, unknown>;
    expect(withActions.message).toBe("");
    expect(withActions.reasoning_summary).toBe("");
    expect(withActions.actions).toEqual([
      { type: "CLICK", params: { x: 500, y: 100 } },
    ]);

    const withoutActions = normalizeRawPlan({
      status: "ACTION_REQUIRED",
    }) as Record<string, unknown>;
    expect(withoutActions.message).toBe("");
    expect(withoutActions.reasoning_summary).toBe("");
    expect(withoutActions.actions).toBeUndefined();
  });

  it("rejects ACTION_REQUIRED with no actions field", () => {
    const result = AiPlanResponseSchema.safeParse({
      status: "ACTION_REQUIRED",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown action types in a plan", () => {
    const result = AiPlanResponseSchema.safeParse({
      status: "ACTION_REQUIRED",
      actions: [{ type: "INVALID_ACTION" }],
    });
    expect(result.success).toBe(false);
  });

  it("still rejects out-of-bounds negative click coordinates via safety", () => {
    const plan = AiPlanResponseSchema.parse({
      status: "ACTION_REQUIRED",
      reasoning_summary: "bad click",
      actions: [
        {
          type: "CLICK",
          params: { x: -500, y: 100 },
        },
      ],
      message: "click",
    });
    const safety = validateActionSafety(plan.actions, screenshot);
    expect(safety.ok).toBe(false);
    expect(
      safety.violations.some((v) => v.code === "COORDINATE_OUT_OF_BOUNDS"),
    ).toBe(true);
  });
});

describe("vision plan schema resilience", () => {
  it("planWithVision accepts model JSON missing message", async () => {
    const provider: AiProvider = {
      name: "mock",
      async complete(
        _req: AiCompletionRequest,
      ): Promise<AiCompletionResponse> {
        return {
          content: JSON.stringify({
            status: "ACTION_REQUIRED",
            reasoning_summary: "Open a new browser tab.",
            actions: [
              {
                type: "HOTKEY",
                params: {
                  keys: ["META", "T"],
                },
              },
            ],
          }),
          model: "mock-model",
        };
      },
    };

    const plan = await planWithVision({
      provider,
      model: "mock",
      screenshot,
      historySummary: "User instruction: open new tab on google",
      iteration: 1,
      maxIterations: 10,
    });

    expect(plan.message).toBe("");
    expect(plan.status).toBe("ACTION_REQUIRED");
    expect(plan.actions[0]?.type).toBe("HOTKEY");
  });

  it("full pipeline: open new tab on google with HOTKEY and no message", async () => {
    const orch = new Orchestrator({
      provider: {
        name: "mock",
        async complete(): Promise<AiCompletionResponse> {
          return {
            content: JSON.stringify({
              status: "ACTION_REQUIRED",
              reasoning_summary: "Open a new browser tab.",
              actions: [
                {
                  type: "HOTKEY",
                  params: { keys: ["META", "T"] },
                },
              ],
            }),
            model: "mock-model",
          };
        },
      },
      config: {
        provider: "openrouter",
        model: "mock",
        maxIterations: 10,
        maxSameActionRetries: 3,
        openRouterApiKey: "unused",
      },
    });

    const result = await orch.planNextAction({
      userInstruction: "open new tab on google",
      screenshot,
    });

    expect(result.response.status).toBe("ACTION_REQUIRED");
    expect(result.response.message).toBe("");
    expect(result.response.actions).toHaveLength(1);
    expect(result.response.actions[0]?.type).toBe("HOTKEY");
    expect(result.response.actions.every((a) => a.type !== "OPEN_APP")).toBe(
      true,
    );
  });

  it("full pipeline still fails schema when actions are missing", async () => {
    const orch = new Orchestrator({
      provider: {
        name: "mock",
        async complete(): Promise<AiCompletionResponse> {
          return {
            content: JSON.stringify({
              status: "ACTION_REQUIRED",
            }),
            model: "mock-model",
          };
        },
      },
      config: {
        provider: "openrouter",
        model: "mock",
        maxIterations: 10,
        maxSameActionRetries: 3,
        openRouterApiKey: "unused",
      },
    });

    const result = await orch.planNextAction({
      userInstruction: "open new tab on google",
      screenshot,
    });

    expect(result.response.status).toBe("FAILED");
    expect(result.response.message).toMatch(/schema validation/i);
  });
});
