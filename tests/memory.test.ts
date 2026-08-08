import { describe, expect, it } from "vitest";
import {
  createTaskState,
  recordPlannedActions,
  recordActionResults,
  countConsecutiveFailedRepeats,
  countConsecutiveSameActions,
  summarizeHistoryForPrompt,
  stripScreenshotImage,
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

  it("records action results", () => {
    let state = createTaskState({ userInstruction: "test" });
    state = recordActionResults(state, [
      {
        action: { type: "WAIT", params: { ms: 100 } },
        success: true,
        executedAt: new Date().toISOString(),
      },
    ]);
    expect(state.actionResults).toHaveLength(1);
  });

  it("strips screenshot image bytes from task state", () => {
    const stripped = stripScreenshotImage({
      width: 1920,
      height: 1080,
      image: "data:image/png;base64," + "a".repeat(5000),
    });
    expect(stripped.image).toBe("[stripped]");
    expect(stripped.width).toBe(1920);

    const state = createTaskState({
      userInstruction: "x",
      screenshot: {
        width: 10,
        height: 10,
        image: "data:image/png;base64,aaaa",
      },
    });
    expect(state.currentScreenshot?.image).toBe("[stripped]");
  });

  it("task state is JSON-serializable", () => {
    let state = createTaskState({ userInstruction: "Open YouTube" });
    state = recordPlannedActions(
      state,
      [{ type: "OPEN_APP", params: { app: "Google Chrome" } }],
      "running",
    );
    const json = JSON.stringify(state);
    const restored = JSON.parse(json);
    expect(restored.userInstruction).toBe("Open YouTube");
    expect(restored.iteration).toBe(1);
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
    expect(fingerprint).toBe("CLICK:10:10:left");
  });

  it("detects consecutive identical actions", () => {
    const actions: ComputerAction[] = [
      { type: "WAIT", params: { ms: 500 } },
      { type: "WAIT", params: { ms: 500 } },
      { type: "WAIT", params: { ms: 500 } },
    ];
    expect(countConsecutiveSameActions(actions).count).toBe(3);
  });

  it("summarizes history for prompts without dumping TYPE_TEXT plaintext", () => {
    let state = createTaskState({ userInstruction: "Open YouTube" });
    state = recordPlannedActions(
      state,
      [
        { type: "OPEN_APP", params: { app: "Google Chrome" } },
        { type: "TYPE_TEXT", params: { text: "super-secret-token" } },
      ],
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
    expect(summary).toContain("TYPE_TEXT fp=");
    expect(summary).not.toContain("super-secret-token");
    expect(summary).toContain("success");
  });
});
