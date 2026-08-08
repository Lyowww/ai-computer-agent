import { describe, expect, it } from "vitest";
import {
  ComputerActionSchema,
  AiPlanResponseSchema,
  ScreenshotSchema,
  normalizeRawAction,
} from "../src/schemas/index.js";
import {
  parseAction,
  tryParseAction,
  actionFingerprint,
  isSupportedActionType,
  hashTextFingerprint,
} from "../src/actions/index.js";

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
});
