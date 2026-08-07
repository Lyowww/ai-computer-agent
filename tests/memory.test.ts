import { describe, expect, it } from "vitest";
import {
  createTaskState,
  recordPlannedActions,
  recordActionResults,
  countConsecutiveFailedRepeats,
  countConsecutiveSameActions,
  summarizeHistoryForPrompt,
} from "../src/memory/index.js";
import type { ActionResult, ComputerAction } from "../src/types/index.js";

describe("task memory & loop detection", () => {
  it("creates a task with defaults", () => {
    const state = createTaskState({
      userInstruction: "Open Chrome and go to youtube.com",
    });
    expect(state.taskId).toMatch(/^task_/);
    expect(state.iteration).toBe(0);
    expect(state.status).toBe("pending");
    expect(state.previousActions).toEqual([]);
  });

  it("records planned actions and increments iteration", () => {
    let state = createTaskState({ userInstruction: "test" });
    const actions: ComputerAction[] = [
      { type: "OPEN_APP", params: { app: "Google Chrome" } },
    ];
    state = recordPlannedActions(state, actions, "running");
    expect(state.iteration).toBe(1);
    expect(state.previousActions).toHaveLength(1);
  });

  it("detects consecutive failed repeats", () => {
    const click: ComputerAction = {
      type: "CLICK",
      params: { x: 10, y: 10, button: "LEFT" },
    };
    const results: ActionResult[] = [
      {
        action: click,
        success: false,
        error: "miss",
        executedAt: new Date().toISOString(),
      },
      {
        action: click,
        success: false,
        error: "miss",
        executedAt: new Date().toISOString(),
      },
      {
        action: click,
        success: false,
        error: "miss",
        executedAt: new Date().toISOString(),
      },
    ];
    const { count, fingerprint } = countConsecutiveFailedRepeats(results);
    expect(count).toBe(3);
    expect(fingerprint).toContain("CLICK");
  });

  it("detects consecutive identical actions", () => {
    const actions: ComputerAction[] = [
      { type: "WAIT", params: { ms: 500 } },
      { type: "WAIT", params: { ms: 500 } },
      { type: "WAIT", params: { ms: 500 } },
    ];
    expect(countConsecutiveSameActions(actions).count).toBe(3);
  });

  it("summarizes history for prompts", () => {
    let state = createTaskState({ userInstruction: "Open YouTube" });
    state = recordPlannedActions(
      state,
      [{ type: "OPEN_APP", params: { app: "Google Chrome" } }],
      "running",
    );
    state = recordActionResults(state, [
      {
        action: { type: "OPEN_APP", params: { app: "Google Chrome" } },
        success: true,
        executedAt: new Date().toISOString(),
      },
    ]);
    const summary = summarizeHistoryForPrompt(state);
    expect(summary).toContain("Open YouTube");
    expect(summary).toContain("OPEN_APP");
    expect(summary).toContain("success");
  });
});
