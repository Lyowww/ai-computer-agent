import { describe, expect, it } from "vitest";
import { validateActionSafety } from "../src/safety/index.js";
import type { ComputerAction, Screenshot } from "../src/types/index.js";

const shot: Screenshot = {
  width: 1920,
  height: 1080,
  image: "data:image/png;base64,aaa",
};

describe("action safety layer", () => {
  it("allows in-bounds clicks", () => {
    const actions: ComputerAction[] = [
      { type: "CLICK", params: { x: 100, y: 200, button: "LEFT" } },
    ];
    const result = validateActionSafety(actions, shot);
    expect(result.ok).toBe(true);
    expect(result.safeActions).toHaveLength(1);
  });

  it("blocks out-of-bounds coordinates", () => {
    const actions: ComputerAction[] = [
      { type: "CLICK", params: { x: 5000, y: 10, button: "LEFT" } },
    ];
    const result = validateActionSafety(actions, shot);
    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe("COORDINATE_OUT_OF_BOUNDS");
    expect(result.safeActions).toHaveLength(0);
  });

  it("blocks shell-like TYPE_TEXT content", () => {
    const actions: ComputerAction[] = [
      { type: "TYPE_TEXT", params: { text: "sudo rm -rf /" } },
    ];
    const result = validateActionSafety(actions, shot);
    expect(result.ok).toBe(false);
    expect(
      result.violations.some((v) => v.code === "BLOCKED_SCRIPT_CONTENT"),
    ).toBe(true);
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
