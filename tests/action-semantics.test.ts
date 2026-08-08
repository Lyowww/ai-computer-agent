import { describe, expect, it } from "vitest";
import {
  classifyUserIntent,
  isContinuationRequest,
  resolveContinuationInstruction,
  validateActionAgainstIntent,
  validateOpenAppAction,
  looksLikeApplicationName,
  instructionImpliesUiOpen,
} from "../src/intent/index.js";
import { Orchestrator } from "../src/orchestrator/index.js";
import { parseAction } from "../src/actions/index.js";
import { ComputerActionSchema } from "../src/schemas/index.js";
import type {
  AiCompletionRequest,
  AiCompletionResponse,
  AiProvider,
  Screenshot,
} from "../src/types/index.js";

const screenshot: Screenshot = {
  width: 1280,
  height: 800,
  image: "not-a-real-png-payload-for-tests",
};

function mockProvider(plan: unknown): AiProvider {
  return {
    name: "mock",
    async complete(_req: AiCompletionRequest): Promise<AiCompletionResponse> {
      return {
        content: typeof plan === "string" ? plan : JSON.stringify(plan),
        model: "mock-model",
      };
    },
  };
}

function orchestratorWith(plan: unknown): Orchestrator {
  return new Orchestrator({
    provider: mockProvider(plan),
    config: {
      provider: "openrouter",
      model: "mock",
      maxIterations: 10,
      maxSameActionRetries: 3,
      openRouterApiKey: "unused",
    },
  });
}

describe("action semantics — intent classification", () => {
  it("Test A: scroll down → SCROLL intent, never CLICK", () => {
    const intent = classifyUserIntent("scroll down");
    expect(intent.intent).toBe("SCROLL");
    expect(intent.scrollDirection).toBe("down");
  });

  it("Test B: scroll dm-s in Slack to bottom → SCROLL down toEnd", () => {
    const intent = classifyUserIntent("scroll dm-s in slack to bottom");
    expect(intent.intent).toBe("SCROLL");
    expect(intent.scrollDirection).toBe("down");
    expect(intent.scrollToEnd).toBe(true);
  });

  it('open Slack → OPEN_APP("Slack")', () => {
    const intent = classifyUserIntent("open Slack");
    expect(intent.intent).toBe("OPEN_APP");
    expect(intent.targetLabel?.toLowerCase()).toBe("slack");
  });

  it('launch Telegram → OPEN_APP("Telegram")', () => {
    const intent = classifyUserIntent("launch Telegram");
    expect(intent.intent).toBe("OPEN_APP");
    expect(intent.targetLabel?.toLowerCase()).toBe("telegram");
  });

  it("open new tab on google → NOT OPEN_APP", () => {
    const intent = classifyUserIntent("open new tab on google");
    expect(intent.intent).not.toBe("OPEN_APP");
    expect(intent.targetLabel?.toLowerCase()).not.toBe("new");
  });

  it("open new tab in Chrome → NOT OPEN_APP", () => {
    const intent = classifyUserIntent("open new tab in Chrome");
    expect(intent.intent).not.toBe("OPEN_APP");
    expect(intent.targetLabel?.toLowerCase()).not.toBe("new");
  });

  it("open Dashboard tab → CLICK", () => {
    const intent = classifyUserIntent("open Dashboard tab");
    expect(intent.intent).toBe("CLICK");
    expect(intent.targetLabel?.toLowerCase()).toContain("dashboard");
  });

  it("open Processes tab → CLICK", () => {
    const intent = classifyUserIntent("open Processes tab");
    expect(intent.intent).toBe("CLICK");
    expect(intent.targetLabel?.toLowerCase()).toContain("processes");
  });

  it("open Settings tab → CLICK", () => {
    const intent = classifyUserIntent("open Settings tab");
    expect(intent.intent).toBe("CLICK");
    expect(intent.targetLabel?.toLowerCase()).toContain("settings");
  });

  it("open sidebar → CLICK", () => {
    const intent = classifyUserIntent("open sidebar");
    expect(intent.intent).toBe("CLICK");
  });

  it("open ChatGPT tab in Chrome → CLICK (not OPEN_APP ChatGPT)", () => {
    const intent = classifyUserIntent("open ChatGPT tab in Chrome");
    expect(intent.intent).toBe("CLICK");
    expect(intent.targetLabel?.toLowerCase()).toContain("chatgpt");
  });

  it("open in left sidebar dashboard tab → CLICK (not OPEN_APP in)", () => {
    const intent = classifyUserIntent("open in left sidebar dashboard tab");
    expect(intent.intent).toBe("CLICK");
    expect(intent.targetLabel?.toLowerCase()).not.toBe("in");
    expect(intent.targetLabel?.toLowerCase()).toContain("dashboard");
  });

  it("scroll Slack DMs to bottom → SCROLL toEnd", () => {
    const intent = classifyUserIntent("scroll Slack DMs to bottom");
    expect(intent.intent).toBe("SCROLL");
    expect(intent.scrollDirection).toBe("down");
    expect(intent.scrollToEnd).toBe(true);
  });

  it("Test F: click refresh → CLICK", () => {
    const intent = classifyUserIntent("click refresh");
    expect(intent.intent).toBe("CLICK");
  });

  it("Test G: scroll to bottom → SCROLL toEnd not CLICK bottom", () => {
    const intent = classifyUserIntent("scroll to bottom");
    expect(intent.intent).toBe("SCROLL");
    expect(intent.scrollDirection).toBe("down");
    expect(intent.scrollToEnd).toBe(true);
  });

  it("Open Chrome → OPEN_APP with Chrome", () => {
    const intent = classifyUserIntent("Open Chrome");
    expect(intent.intent).toBe("OPEN_APP");
    expect(intent.targetLabel?.toLowerCase()).toContain("chrome");
  });

  it("open Google Chrome → multi-word app name", () => {
    const intent = classifyUserIntent("open Google Chrome");
    expect(intent.intent).toBe("OPEN_APP");
    expect(intent.targetLabel?.toLowerCase()).toBe("google chrome");
  });
});

describe("OPEN_APP validation layer", () => {
  it("accepts real application names", () => {
    expect(looksLikeApplicationName("Slack")).toBe(true);
    expect(looksLikeApplicationName("Telegram")).toBe(true);
    expect(looksLikeApplicationName("Google Chrome")).toBe(true);
    expect(
      validateOpenAppAction({ type: "OPEN_APP", params: { app: "Slack" } }).ok,
    ).toBe(true);
  });

  it('rejects OPEN_APP("new") / OPEN_APP("in") / UI nouns', () => {
    for (const app of ["new", "in", "tab", "dashboard", "settings"]) {
      expect(looksLikeApplicationName(app)).toBe(false);
      const result = validateOpenAppAction({
        type: "OPEN_APP",
        params: { app },
      });
      expect(result.ok).toBe(false);
      expect(result.needsUserInput).toBe(true);
    }
  });

  it("rejects OPEN_APP when instruction is UI open", () => {
    expect(instructionImpliesUiOpen("open new tab on google")).toBe(true);
    const result = validateOpenAppAction(
      { type: "OPEN_APP", params: { app: "Chrome" } },
      "open new tab on google",
    );
    expect(result.ok).toBe(false);
  });

  it("does not convert failed OPEN_APP into another action type", () => {
    const result = validateActionAgainstIntent("open new tab on google", [
      { type: "OPEN_APP", params: { app: "new" } },
    ]);
    expect(result.ok).toBe(false);
    expect(result.needsUserInput).toBe(true);
  });
});

describe("action semantics — validateActionAgainstIntent", () => {
  it("rejects CLICK when user asked to scroll", () => {
    const result = validateActionAgainstIntent("scroll down", [
      { type: "CLICK", params: { x: 204, y: 809, button: "LEFT" } },
    ]);
    expect(result.ok).toBe(false);
    expect(result.needsUserInput).toBe(true);
  });

  it("accepts SCROLL when user asked to scroll", () => {
    const result = validateActionAgainstIntent("scroll down", [
      { type: "SCROLL", params: { direction: "down", amount: 5 } },
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects CLICK when user asked to open Slack", () => {
    const result = validateActionAgainstIntent("open Slack", [
      { type: "CLICK", params: { x: 200, y: 500, button: "LEFT" } },
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects OPEN_APP when user asked to open Dashboard tab", () => {
    const result = validateActionAgainstIntent("open Dashboard tab", [
      { type: "OPEN_APP", params: { app: "Dashboard" } },
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects substituted targetLabel for ChatGPT tab", () => {
    const result = validateActionAgainstIntent("click ChatGPT tab", [
      {
        type: "CLICK",
        params: {
          x: 100,
          y: 40,
          button: "LEFT",
          targetLabel: "AI Setup for Backend",
          targetConfidence: 0.9,
        },
      },
    ]);
    expect(result.ok).toBe(false);
  });

  it("accepts matching ChatGPT target", () => {
    const result = validateActionAgainstIntent("click ChatGPT tab", [
      {
        type: "CLICK",
        params: {
          x: 100,
          y: 40,
          button: "LEFT",
          targetLabel: "ChatGPT",
          targetConfidence: 0.94,
        },
      },
    ]);
    expect(result.ok).toBe(true);
  });
});

describe("action semantics — orchestrator end-to-end", () => {
  it("Test A/B/G: scroll instructions emit SCROLL (never CLICK)", async () => {
    // Even if the vision model wrongly returns CLICK, deterministic path wins first.
    const orch = orchestratorWith({
      status: "ACTION_REQUIRED",
      reasoning_summary: "Scrolling the DMs in Slack to the bottom.",
      actions: [{ type: "CLICK", params: { x: 204, y: 809, button: "LEFT" } }],
      message: "Scrolling…",
    });

    for (const instruction of [
      "scroll down",
      "scroll dm-s in slack to bottom",
      "scroll to bottom",
      "scroll Slack DMs to bottom",
    ]) {
      const result = await orch.planNextAction({
        userInstruction: instruction,
        screenshot,
      });
      expect(result.response.actions).toHaveLength(1);
      expect(result.response.actions[0]?.type).toBe("SCROLL");
      expect(result.response.actions.every((a) => a.type !== "CLICK")).toBe(
        true,
      );
      if (result.response.actions[0]?.type === "SCROLL") {
        expect(result.response.actions[0].params.direction).toBe("down");
        if (/bottom/i.test(instruction)) {
          expect(result.response.actions[0].params.toEnd).toBe(true);
        } else {
          expect(typeof result.response.actions[0].params.amount).toBe(
            "number",
          );
        }
      }
    }
  });

  it('open new tab on google never emits OPEN_APP("new")', async () => {
    const orch = orchestratorWith({
      status: "ACTION_REQUIRED",
      reasoning_summary: "Opening new as an app.",
      actions: [{ type: "OPEN_APP", params: { app: "new" } }],
      message: "Opening new.",
    });

    const result = await orch.planNextAction({
      userInstruction: "open new tab on google",
      screenshot,
    });

    expect(
      result.response.actions.every(
        (a) =>
          !(
            a.type === "OPEN_APP" &&
            typeof a.params.app === "string" &&
            a.params.app.toLowerCase() === "new"
          ),
      ),
    ).toBe(true);
    expect(result.response.actions.every((a) => a.type !== "OPEN_APP")).toBe(
      true,
    );
    expect(result.response.status).toBe("NEEDS_USER_INPUT");
  });

  it('open in left sidebar dashboard tab never emits OPEN_APP("in")', async () => {
    const orch = orchestratorWith({
      status: "ACTION_REQUIRED",
      reasoning_summary: "Wrongly opening in.",
      actions: [{ type: "OPEN_APP", params: { app: "in" } }],
      message: "Opening in.",
    });

    const result = await orch.planNextAction({
      userInstruction: "open in left sidebar dashboard tab",
      screenshot,
    });

    expect(result.response.actions.every((a) => a.type !== "OPEN_APP")).toBe(
      true,
    );
    // Intent is CLICK — OPEN_APP is rejected; do not invent another action
    expect(result.response.status).toBe("NEEDS_USER_INPUT");
  });

  it("open Dashboard tab plans CLICK Dashboard", async () => {
    const orch = orchestratorWith({
      status: "ACTION_REQUIRED",
      reasoning_summary: "Dashboard is in the sidebar.",
      actions: [
        {
          type: "CLICK",
          params: {
            x: 104,
            y: 469,
            button: "LEFT",
            targetLabel: "Dashboard",
            targetConfidence: 0.93,
          },
        },
      ],
      message: "Clicking Dashboard.",
    });

    const result = await orch.planNextAction({
      userInstruction: "open Dashboard tab",
      screenshot,
    });

    expect(result.response.status).toBe("ACTION_REQUIRED");
    expect(result.response.actions[0]?.type).toBe("CLICK");
    if (result.response.actions[0]?.type === "CLICK") {
      expect(result.response.actions[0].params.targetLabel).toBe("Dashboard");
    }
  });

  it("open ChatGPT tab in Chrome plans CLICK not OPEN_APP", async () => {
    const orch = orchestratorWith({
      status: "ACTION_REQUIRED",
      reasoning_summary: "ChatGPT tab visible.",
      actions: [
        {
          type: "CLICK",
          params: {
            x: 120,
            y: 36,
            button: "LEFT",
            targetLabel: "ChatGPT",
            targetConfidence: 0.95,
          },
        },
      ],
      message: "Clicking ChatGPT tab.",
    });

    const result = await orch.planNextAction({
      userInstruction: "open ChatGPT tab in Chrome",
      screenshot,
    });

    expect(result.response.actions[0]?.type).toBe("CLICK");
    expect(result.response.actions.every((a) => a.type !== "OPEN_APP")).toBe(
      true,
    );
  });

  it("Test C: missing ChatGPT → NEEDS_USER_INPUT, no click", async () => {
    const orch = orchestratorWith({
      status: "NEEDS_USER_INPUT",
      reasoning_summary: "Cannot find chatgpt tab in google.",
      actions: [
        {
          type: "ASK_USER",
          params: {
            question: "Cannot find 'chatgpt tab in google' in the current view.",
          },
        },
      ],
      message: "Cannot find 'chatgpt tab in google' in the current view.",
    });

    const result = await orch.planNextAction({
      userInstruction: "click on chatgpt tab in google",
      screenshot,
    });

    expect(result.response.status).toBe("NEEDS_USER_INPUT");
    expect(result.response.actions.every((a) => a.type !== "CLICK")).toBe(true);
  });

  it("Test C variant: model substitutes another tab → rejected, no CLICK executed", async () => {
    const orch = orchestratorWith({
      status: "ACTION_REQUIRED",
      reasoning_summary: "Cannot find ChatGPT; clicking similar tab.",
      actions: [
        {
          type: "CLICK",
          params: {
            x: 220,
            y: 40,
            button: "LEFT",
            targetLabel: "AI Setup for Backend",
            targetConfidence: 0.8,
          },
        },
      ],
      message: "Clicked on the 'AI Setup for Backend' tab.",
    });

    const result = await orch.planNextAction({
      userInstruction: "click ChatGPT tab",
      screenshot,
    });

    expect(result.response.status).toBe("NEEDS_USER_INPUT");
    expect(result.response.actions.every((a) => a.type !== "CLICK")).toBe(true);
  });

  it("Test D: ChatGPT visible → CLICK ChatGPT only", async () => {
    const orch = orchestratorWith({
      status: "ACTION_REQUIRED",
      reasoning_summary: "ChatGPT tab is visible.",
      actions: [
        {
          type: "CLICK",
          params: {
            x: 120,
            y: 36,
            button: "LEFT",
            targetLabel: "ChatGPT",
            targetConfidence: 0.95,
            targetSource: "visible text",
          },
        },
      ],
      message: "Clicking ChatGPT tab.",
    });

    const result = await orch.planNextAction({
      userInstruction: "click ChatGPT tab",
      screenshot,
    });

    expect(result.response.status).toBe("ACTION_REQUIRED");
    expect(result.response.actions).toHaveLength(1);
    expect(result.response.actions[0]?.type).toBe("CLICK");
    if (result.response.actions[0]?.type === "CLICK") {
      expect(result.response.actions[0].params.targetLabel).toBe("ChatGPT");
    }
  });

  it("Test E: open Slack → OPEN_APP, never CLICK", async () => {
    const orch = orchestratorWith({
      status: "ACTION_REQUIRED",
      reasoning_summary: "Opening Slack via dock click.",
      actions: [{ type: "CLICK", params: { x: 10, y: 10, button: "LEFT" } }],
      message: "Clicking Slack.",
    });

    const result = await orch.planNextAction({
      userInstruction: "open Slack",
      screenshot,
    });

    expect(result.response.actions[0]?.type).toBe("OPEN_APP");
    if (result.response.actions[0]?.type === "OPEN_APP") {
      expect(result.response.actions[0].params.app.toLowerCase()).toBe("slack");
    }
    expect(result.response.actions.every((a) => a.type !== "CLICK")).toBe(true);
  });

  it("launch Telegram → OPEN_APP", async () => {
    const orch = orchestratorWith({
      status: "ACTION_REQUIRED",
      reasoning_summary: "noop",
      actions: [{ type: "CLICK", params: { x: 1, y: 1, button: "LEFT" } }],
      message: "noop",
    });

    const result = await orch.planNextAction({
      userInstruction: "launch Telegram",
      screenshot,
    });

    expect(result.response.actions[0]?.type).toBe("OPEN_APP");
    if (result.response.actions[0]?.type === "OPEN_APP") {
      expect(result.response.actions[0].params.app.toLowerCase()).toBe(
        "telegram",
      );
    }
  });

  it("Test F: click refresh → exactly one CLICK", async () => {
    const orch = orchestratorWith({
      status: "ACTION_REQUIRED",
      reasoning_summary: "Refresh button visible.",
      actions: [
        {
          type: "CLICK",
          params: {
            x: 50,
            y: 50,
            button: "LEFT",
            targetLabel: "refresh",
            targetConfidence: 0.9,
          },
        },
      ],
      message: "Clicking refresh.",
    });

    const result = await orch.planNextAction({
      userInstruction: "click refresh",
      screenshot,
    });

    expect(result.response.actions.filter((a) => a.type === "CLICK")).toHaveLength(
      1,
    );
  });

  it("rejects reasoning_summary saying scroll while action is CLICK", async () => {
    // Non-scroll instruction so deterministic path is skipped; intent CLICK
    // with a scroll-looking reasoning must still validate structured action.
    const orch = orchestratorWith({
      status: "ACTION_REQUIRED",
      reasoning_summary: "Scrolling the DMs in Slack to the bottom.",
      actions: [
        {
          type: "CLICK",
          params: { x: 204, y: 809, button: "LEFT", targetLabel: "x" },
        },
      ],
      message: "Scrolling…",
    });

    const result = await orch.planNextAction({
      userInstruction: "scroll dm-s in slack to bottom",
      screenshot,
    });

    // Deterministic SCROLL path — never executes the model's CLICK.
    expect(result.response.actions[0]?.type).toBe("SCROLL");
  });
});

describe("continuation / again", () => {
  it("detects again phrases", () => {
    expect(
      isContinuationRequest("again do action i dont see it done"),
    ).toBe(true);
    expect(isContinuationRequest("retry that")).toBe(true);
    expect(isContinuationRequest("open Slack")).toBe(false);
  });

  it("resolves again to previous instruction", () => {
    const resolved = resolveContinuationInstruction(
      "again do action i dont see it done",
      "scroll dm-s in slack to bottom",
    );
    expect(resolved.unresolved).toBe(false);
    expect(resolved.instruction).toBe("scroll dm-s in slack to bottom");
  });

  it("asks user when again has no previous task", async () => {
    const orch = orchestratorWith({
      status: "ACTION_REQUIRED",
      reasoning_summary: "Inventing something.",
      actions: [{ type: "CLICK", params: { x: 1, y: 1, button: "LEFT" } }],
      message: "Clicking.",
    });

    const result = await orch.planNextAction({
      userInstruction: "again do action i dont see it done",
      screenshot,
      previousTaskInstruction: null,
    });

    expect(result.response.status).toBe("NEEDS_USER_INPUT");
    expect(result.response.actions.every((a) => a.type !== "CLICK")).toBe(true);
  });

  it("retries previous scroll on again with prior instruction", async () => {
    const orch = orchestratorWith({
      status: "ACTION_REQUIRED",
      reasoning_summary: "noop",
      actions: [{ type: "CLICK", params: { x: 1, y: 1, button: "LEFT" } }],
      message: "noop",
    });

    const result = await orch.planNextAction({
      userInstruction: "again",
      screenshot,
      previousTaskInstruction: "scroll down",
    });

    expect(result.response.actions[0]?.type).toBe("SCROLL");
  });
});

describe("SCROLL schema", () => {
  it("parses SCROLL actions", () => {
    const action = parseAction({
      type: "SCROLL",
      params: { direction: "down", amount: 25 },
    });
    expect(action.type).toBe("SCROLL");
    if (action.type === "SCROLL") {
      expect(action.params.direction).toBe("down");
      expect(action.params.amount).toBe(25);
      expect(action.params.toEnd).toBe(false);
    }
  });

  it("never normalizes SCROLL into CLICK", () => {
    const action = parseAction({
      type: "SCROLL",
      direction: "down",
      amount: 5,
    });
    expect(action.type).toBe("SCROLL");
  });

  it("coerces numeric string amount to number", () => {
    const action = parseAction({
      type: "SCROLL",
      params: { direction: "down", amount: "5" },
    });
    expect(action.type).toBe("SCROLL");
    if (action.type === "SCROLL") {
      expect(action.params.amount).toBe(5);
      expect(typeof action.params.amount).toBe("number");
    }
  });

  it('maps amount "large" to a numeric notch count', () => {
    const action = parseAction({
      type: "SCROLL",
      params: { direction: "down", amount: "large" },
    });
    expect(action.type).toBe("SCROLL");
    if (action.type === "SCROLL") {
      expect(typeof action.params.amount).toBe("number");
      expect(action.params.amount).toBeGreaterThan(0);
      expect(action.params.toEnd).toBe(false);
    }
  });

  it('maps amount "bottom" to toEnd=true', () => {
    const action = parseAction({
      type: "SCROLL",
      params: { direction: "down", amount: "bottom" },
    });
    expect(action.type).toBe("SCROLL");
    if (action.type === "SCROLL") {
      expect(action.params.toEnd).toBe(true);
    }
  });

  it("accepts explicit toEnd for scroll to bottom", () => {
    const action = parseAction({
      type: "SCROLL",
      params: { direction: "down", toEnd: true },
    });
    expect(action.type).toBe("SCROLL");
    if (action.type === "SCROLL") {
      expect(action.params.toEnd).toBe(true);
    }
  });

  it('rejects unknown amount string "banana"', () => {
    expect(
      ComputerActionSchema.safeParse({
        type: "SCROLL",
        params: { direction: "down", amount: "banana" },
      }).success,
    ).toBe(false);
  });
});
