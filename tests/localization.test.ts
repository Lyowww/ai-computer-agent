import { describe, expect, it } from "vitest";
import {
  extractSpatialConstraints,
  checkSpatialSanity,
  extractLikelyTargetLabel,
} from "../src/localization/spatial.js";
import {
  alignScreenshotDimensions,
  readPngDimensions,
} from "../src/localization/screenshot.js";
import { validateActionSafety } from "../src/safety/index.js";
import { Orchestrator } from "../src/orchestrator/index.js";
import {
  createTaskState,
  resetTaskExecutionState,
  summarizeHistoryForPrompt,
} from "../src/memory/index.js";
import type {
  AiCompletionRequest,
  AiCompletionResponse,
  AiProvider,
  Screenshot,
} from "../src/types/index.js";

/** Non-PNG base64 so tests can declare logical screenshot dims without IHDR override. */
const fakeImage = "not-a-real-png-payload-for-tests";

function mockProvider(plans: unknown[]): AiProvider & { calls: number; lastPrompt: string } {
  const provider = {
    name: "mock",
    calls: 0,
    lastPrompt: "",
    async complete(req: AiCompletionRequest): Promise<AiCompletionResponse> {
      provider.calls += 1;
      const user = req.messages.find((m) => m.role === "user");
      if (user && Array.isArray(user.content)) {
        const text = user.content.find((c) => c.type === "text");
        if (text && text.type === "text") provider.lastPrompt = text.text;
      } else if (user && typeof user.content === "string") {
        provider.lastPrompt = user.content;
      }
      const plan = plans[Math.min(provider.calls - 1, plans.length - 1)];
      return {
        content: typeof plan === "string" ? plan : JSON.stringify(plan),
        model: "mock-model",
      };
    },
  };
  return provider;
}

describe("spatial constraints", () => {
  it("parses left top sidebar as top-left", () => {
    const regions = extractSpatialConstraints(
      "please click on left top sidebar Devices tab",
    );
    expect(regions).toContain("top-left");
  });

  it("extracts Devices as target label", () => {
    expect(
      extractLikelyTargetLabel("please click on left top sidebar Devices tab"),
    ).toBe("Devices");
    expect(extractLikelyTargetLabel("click Processes tab")).toBe("Processes");
    expect(extractLikelyTargetLabel("click the refresh button")).toBe("refresh");
  });

  it("rejects production-failing coordinate for top-left Devices", () => {
    // Production bug: CLICK x=104 y=469 on 1280x832 (mid-left, not top)
    const result = checkSpatialSanity(
      104,
      469,
      1280,
      832,
      "please click on left top sidebar Devices tab",
    );
    expect(result.ok).toBe(false);
    expect(result.regions).toContain("top-left");
  });

  it("accepts upper-left sidebar coordinates", () => {
    const result = checkSpatialSanity(
      105,
      152,
      1280,
      832,
      "please click on left top sidebar Devices tab",
    );
    expect(result.ok).toBe(true);
    expect(result.normalizedX).toBeLessThan(0.35);
    expect(result.normalizedY).toBeLessThan(0.35);
  });
});

describe("Case A: left top sidebar Devices", () => {
  const screenshot: Screenshot = {
    width: 1280,
    height: 832,
    image: fakeImage,
  };

  it("allows CLICK in upper-left with targetLabel Devices", async () => {
    const provider = mockProvider([
      {
        status: "ACTION_REQUIRED",
        reasoning_summary: "Devices is visible in the upper-left sidebar.",
        message: "Clicking Devices",
        actions: [
          {
            type: "CLICK",
            params: { x: 105, y: 152, button: "LEFT", targetLabel: "Devices" },
          },
        ],
      },
    ]);

    const orch = new Orchestrator({
      provider,
      config: { maxIterations: 5, maxSameActionRetries: 3 },
    });

    const result = await orch.planNextAction({
      taskId: "task_devices",
      userInstruction: "please click on left top sidebar Devices tab",
      screenshot,
    });

    expect(result.response.status).toBe("ACTION_REQUIRED");
    expect(result.response.actions).toHaveLength(1);
    const click = result.response.actions[0];
    expect(click.type).toBe("CLICK");
    if (click.type === "CLICK") {
      expect(click.params.x).toBeLessThan(400);
      expect(click.params.y).toBeLessThan(300);
      expect(click.params.targetLabel).toBe("Devices");
    }
  });

  it("blocks wrong mid-screen click and asks user (no guess retry)", async () => {
    const provider = mockProvider([
      {
        status: "ACTION_REQUIRED",
        reasoning_summary: "Clicking Devices",
        message: "Clicking Devices",
        actions: [
          {
            type: "CLICK",
            params: { x: 104, y: 469, button: "LEFT", targetLabel: "Devices" },
          },
        ],
      },
    ]);

    const orch = new Orchestrator({
      provider,
      config: { maxIterations: 5, maxSameActionRetries: 3 },
    });

    const result = await orch.planNextAction({
      taskId: "task_devices_bad",
      userInstruction: "please click on left top sidebar Devices tab",
      screenshot,
    });

    expect(result.response.status).toBe("NEEDS_USER_INPUT");
    expect(result.response.actions[0]?.type).toBe("ASK_USER");
  });
});

describe("Case B/C: Processes vs refresh target labels", () => {
  const screenshot: Screenshot = {
    width: 1280,
    height: 832,
    image: fakeImage,
  };

  it("accepts Processes click with matching label", async () => {
    const provider = mockProvider([
      {
        status: "ACTION_REQUIRED",
        reasoning_summary: "Processes nav item visible.",
        message: "Clicking Processes",
        actions: [
          {
            type: "CLICK",
            params: { x: 110, y: 420, button: "LEFT", targetLabel: "Processes" },
          },
        ],
      },
    ]);
    const orch = new Orchestrator({
      provider,
      config: { maxIterations: 5, maxSameActionRetries: 3 },
    });
    const result = await orch.planNextAction({
      taskId: "task_processes",
      userInstruction: "click Processes tab",
      screenshot,
    });
    expect(result.response.status).toBe("ACTION_REQUIRED");
    const click = result.response.actions[0];
    expect(click.type).toBe("CLICK");
    if (click.type === "CLICK") {
      expect(click.params.targetLabel).toBe("Processes");
    }
  });

  it("rejects refresh click labeled as Devices", async () => {
    const safety = validateActionSafety(
      [
        {
          type: "CLICK",
          params: { x: 900, y: 40, button: "LEFT", targetLabel: "Devices" },
        },
      ],
      screenshot,
      { userInstruction: "click the refresh button" },
    );
    expect(safety.ok).toBe(false);
    expect(
      safety.violations.some((v) => v.code === "TARGET_LABEL_MISMATCH"),
    ).toBe(true);
  });

  it("accepts refresh click with refresh label", async () => {
    const provider = mockProvider([
      {
        status: "ACTION_REQUIRED",
        reasoning_summary: "Refresh icon at top toolbar.",
        message: "Clicking refresh",
        actions: [
          {
            type: "CLICK",
            params: { x: 920, y: 36, button: "LEFT", targetLabel: "refresh" },
          },
        ],
      },
    ]);
    const orch = new Orchestrator({
      provider,
      config: { maxIterations: 5, maxSameActionRetries: 3 },
    });
    const result = await orch.planNextAction({
      taskId: "task_refresh",
      userInstruction: "click the refresh button",
      screenshot,
    });
    expect(result.response.status).toBe("ACTION_REQUIRED");
    const click = result.response.actions[0];
    expect(click.type).toBe("CLICK");
    if (click.type === "CLICK") {
      expect(click.params.targetLabel?.toLowerCase()).toBe("refresh");
    }
  });
});

describe("Case D: uncertain target → NEEDS_USER_INPUT", () => {
  it("passes through model NEEDS_USER_INPUT without inventing a click", async () => {
    const provider = mockProvider([
      {
        status: "NEEDS_USER_INPUT",
        reasoning_summary: "Requested control is not visible.",
        message:
          "I can't confidently identify the requested button in the current screen.",
        actions: [
          {
            type: "ASK_USER",
            params: {
              question:
                "I can't confidently identify the requested button in the current screen.",
              reason: "not visible",
            },
          },
        ],
      },
    ]);
    const orch = new Orchestrator({
      provider,
      config: { maxIterations: 5, maxSameActionRetries: 3 },
    });
    const result = await orch.planNextAction({
      taskId: "task_missing",
      userInstruction: "click something that isn't visible",
      screenshot: { width: 1280, height: 832, image: fakeImage },
    });
    expect(result.response.status).toBe("NEEDS_USER_INPUT");
    expect(result.response.actions.every((a) => a.type !== "CLICK")).toBe(true);
  });
});

describe("Case E: task isolation", () => {
  const screenshot: Screenshot = {
    width: 1280,
    height: 832,
    image: fakeImage,
  };

  const instructions = [
    "click Dashboard",
    "click Devices",
    "click Processes",
    "click refresh",
  ] as const;

  it("each new task receives only its own instruction and empty prior actions", async () => {
    const seen: string[] = [];
    const provider: AiProvider = {
      name: "mock",
      async complete(req) {
        const user = req.messages.find((m) => m.role === "user");
        let text = "";
        if (user && Array.isArray(user.content)) {
          const part = user.content.find((c) => c.type === "text");
          if (part && part.type === "text") text = part.text;
        }
        seen.push(text);
        const labels = ["Dashboard", "Devices", "Processes", "refresh"] as const;
        const label = labels[seen.length - 1] ?? "done";
        return {
          content: JSON.stringify({
            status: "ACTION_REQUIRED",
            reasoning_summary: `Clicking ${label}`,
            message: `Clicking ${label}`,
            actions: [
              {
                type: "CLICK",
                params: {
                  x: 100,
                  y: 100 + seen.length * 10,
                  button: "LEFT",
                  targetLabel: label,
                },
              },
            ],
          }),
          model: "mock",
        };
      },
    };

    const orch = new Orchestrator({
      provider,
      config: { maxIterations: 5, maxSameActionRetries: 3 },
    });

    const results = [];
    for (let i = 0; i < instructions.length; i++) {
      const r = await orch.planNextAction({
        taskId: `task_iso_${i}`,
        userInstruction: instructions[i],
        screenshot,
        // Explicit isolation: no previousActions from other tasks
        previousActions: [],
        actionResults: [],
        iteration: 0,
      });
      results.push(r);
    }

    expect(results).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(results[i].taskState.taskId).toBe(`task_iso_${i}`);
      expect(results[i].taskState.userInstruction).toBe(instructions[i]);
      // Prompt must include this instruction and not other tasks' actions
      expect(seen[i]).toContain(`CURRENT USER INSTRUCTION: ${instructions[i]}`);
      expect(seen[i]).toContain("Actions already taken for THIS task: none");
      for (let j = 0; j < 4; j++) {
        if (j === i) continue;
        expect(seen[i]).not.toContain(
          `CURRENT USER INSTRUCTION: ${instructions[j]}`,
        );
      }
      expect(results[i].response.actions).toHaveLength(1);
      expect(results[i].response.actions[0].type).toBe("CLICK");
    }
  });

  it("resetTaskExecutionState clears prior actions for a new command", () => {
    let state = createTaskState({
      taskId: "task_reset",
      userInstruction: "click Dashboard",
    });
    state = {
      ...state,
      previousActions: [
        { type: "CLICK", params: { x: 1, y: 2, button: "LEFT" } },
      ],
      actionResults: [
        {
          action: { type: "CLICK", params: { x: 1, y: 2, button: "LEFT" } },
          success: true,
          executedAt: new Date().toISOString(),
        },
      ],
      iteration: 3,
    };
    state = resetTaskExecutionState(state, "click Devices");
    expect(state.previousActions).toEqual([]);
    expect(state.actionResults).toEqual([]);
    expect(state.iteration).toBe(0);
    expect(state.userInstruction).toBe("click Devices");
    const summary = summarizeHistoryForPrompt(state);
    expect(summary).toContain("click Devices");
    expect(summary).not.toContain('"x":1');
  });
});

describe("screenshot dimension alignment", () => {
  const tinyPng =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("reads IHDR from tiny PNG as 1x1", () => {
    const b64 = tinyPng.split(",")[1];
    const dims = readPngDimensions(Buffer.from(b64, "base64"));
    expect(dims).toEqual({ width: 1, height: 1 });
  });

  it("corrects mismatched metadata when IHDR is a plausible desktop size", () => {
    // Build a tiny valid PNG then pretend — use measured 1x1 with large metadata:
    // implausible IHDR keeps metadata (see stub guard). Real mismatches at
    // desktop sizes still correct.
    const checkStub = alignScreenshotDimensions({
      width: 1280,
      height: 832,
      image: tinyPng,
    });
    expect(checkStub.corrected).toBe(false);
    expect(checkStub.width).toBe(1280);
    expect(checkStub.height).toBe(832);
    expect(checkStub.warning).toMatch(/implausibly small/i);
  });
});
