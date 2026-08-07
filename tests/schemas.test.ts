import { describe, expect, it } from "vitest";
import {
  ComputerActionSchema,
  AiPlanResponseSchema,
  ScreenshotSchema,
} from "../src/schemas/index.js";
import {
  parseAction,
  tryParseAction,
  actionFingerprint,
  isSupportedActionType,
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

  it("parses TYPE_TEXT and OPEN_APP", () => {
    expect(
      parseAction({ type: "TYPE_TEXT", params: { text: "Hello world" } }).type,
    ).toBe("TYPE_TEXT");
    expect(
      parseAction({ type: "OPEN_APP", params: { app: "Google Chrome" } }).type,
    ).toBe("OPEN_APP");
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

  it("validates full AI plan responses", () => {
    const plan = AiPlanResponseSchema.parse({
      status: "ACTION_REQUIRED",
      reasoning_summary: "Chrome not open; launching it.",
      actions: [{ type: "OPEN_APP", params: { app: "Google Chrome" } }],
      message: "Opening Google Chrome.",
    });
    expect(plan.actions).toHaveLength(1);
  });

  it("validates screenshots", () => {
    const shot = ScreenshotSchema.parse({
      width: 1920,
      height: 1080,
      image: "base64data",
    });
    expect(shot.width).toBe(1920);
  });

  it("builds stable fingerprints", () => {
    const a = parseAction({ type: "CLICK", params: { x: 1, y: 2, button: "LEFT" } });
    const b = parseAction({ type: "CLICK", params: { button: "LEFT", y: 2, x: 1 } });
    expect(actionFingerprint(a)).toBe(actionFingerprint(b));
  });
});
