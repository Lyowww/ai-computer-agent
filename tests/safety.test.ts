import { describe, expect, it } from "vitest";
import { validateActionSafety } from "../src/safety/index.js";
import type { ComputerAction, Screenshot } from "../src/types/index.js";

const shot: Screenshot = {
  width: 1920,
  height: 1080,
  image: "data:image/png;base64,aaa",
};

describe("action safety layer", () => {
  it("allows in-bounds clicks and normal productivity actions", () => {
    const actions: ComputerAction[] = [
      { type: "CLICK", params: { x: 100, y: 200, button: "LEFT" } },
      { type: "OPEN_APP", params: { app: "Google Chrome" } },
      { type: "TYPE_TEXT", params: { text: "youtube.com" } },
      { type: "HOTKEY", params: { keys: ["meta", "l"] } },
    ];
    const result = validateActionSafety(actions, shot, {
      userInstruction: "Open Chrome and search Google",
    });
    expect(result.ok).toBe(true);
    expect(result.safeActions).toHaveLength(4);
  });

  it("blocks out-of-bounds coordinates without clamping", () => {
    const actions: ComputerAction[] = [
      { type: "CLICK", params: { x: 1920, y: 500, button: "LEFT" } },
    ];
    const result = validateActionSafety(actions, shot);
    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe("COORDINATE_OUT_OF_BOUNDS");
    expect(result.safeActions).toHaveLength(0);
  });

  it("blocks shell-like TYPE_TEXT content", () => {
    const samples = [
      "sudo rm -rf /",
      "bash -c 'echo hi'",
      "python3 -c 'print(1)'",
      "tell application \"Finder\" to delete",
    ];
    for (const text of samples) {
      const result = validateActionSafety(
        [{ type: "TYPE_TEXT", params: { text } }],
        shot,
      );
      expect(result.ok).toBe(false);
      expect(
        result.violations.some((v) => v.code === "BLOCKED_SCRIPT_CONTENT"),
      ).toBe(true);
    }
  });

  it("escalates consequential instructions to ASK_USER", () => {
    const actions: ComputerAction[] = [
      { type: "CLICK", params: { x: 10, y: 10, button: "LEFT" } },
    ];
    const result = validateActionSafety(actions, shot, {
      userInstruction: "Delete all files in Documents and empty the trash",
    });
    expect(result.ok).toBe(false);
    expect(result.askUserAction?.type).toBe("ASK_USER");
    expect(result.safeActions[0]?.type).toBe("ASK_USER");
  });

  it("blocks opening Terminal without confirmation", () => {
    const actions: ComputerAction[] = [
      { type: "OPEN_APP", params: { app: "Terminal" } },
    ];
    const result = validateActionSafety(actions, shot);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === "BLOCKED_APP")).toBe(true);
  });

  it("blocks dangerous hotkeys", () => {
    const actions: ComputerAction[] = [
      { type: "HOTKEY", params: { keys: ["Meta", "Q"] } },
    ];
    const result = validateActionSafety(actions, shot);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === "DANGEROUS_HOTKEY")).toBe(
      true,
    );
  });

  it("rejects forbidden executable params", () => {
    const sneaky = {
      type: "WAIT" as const,
      params: { ms: 100, command: "echo hi" },
    } as unknown as ComputerAction;
    const result = validateActionSafety([sneaky], shot);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === "FORBIDDEN_PARAM")).toBe(
      true,
    );
  });
});
