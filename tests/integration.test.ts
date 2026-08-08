import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator/index.js";
import type {
  AiCompletionRequest,
  AiCompletionResponse,
  AiProvider,
  Screenshot,
} from "../src/types/index.js";

const tinyPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const screenshot: Screenshot = {
  width: 1920,
  height: 1080,
  image: tinyPng,
};

/**
 * Integration-style test: fake AiProvider → JSON extraction → Zod → safety → response.
 */
describe("integration: fake AiProvider pipeline", () => {
  it("runs provider → extract → zod → safety → structured response", async () => {
    const provider: AiProvider = {
      name: "mock",
      async complete(req: AiCompletionRequest): Promise<AiCompletionResponse> {
        // Ensure vision path attached an image part
        const user = req.messages.find((m) => m.role === "user");
        expect(user).toBeDefined();
        expect(Array.isArray(user?.content)).toBe(true);
        const parts = user?.content as Array<{ type: string; url?: string }>;
        expect(parts.some((p) => p.type === "image")).toBe(true);

        return {
          content: JSON.stringify({
            status: "ACTION_REQUIRED",
            reasoning_summary: "The button is visible.",
            actions: [
              {
                type: "CLICK",
                x: 500,
                y: 300,
                button: "left",
                targetLabel: "submit",
                targetConfidence: 0.9,
              },
            ],
            message: "Clicking the button.",
          }),
          model: "mock",
        };
      },
    };

    const orchestrator = new Orchestrator({
      provider,
      config: {
        model: "mock",
        maxIterations: 30,
        maxSameActionRetries: 3,
        openRouterApiKey: "unused",
      },
    });

    const { response, taskState } = await orchestrator.planNextAction({
      userInstruction: "Click the submit button",
      screenshot,
    });

    expect(response.status).toBe("ACTION_REQUIRED");
    expect(response.reasoning_summary).toBe("The button is visible.");
    expect(response.actions).toEqual([
      {
        type: "CLICK",
        params: {
          x: 500,
          y: 300,
          button: "LEFT",
          targetLabel: "submit",
          targetConfidence: 0.9,
        },
      },
    ]);
    expect(response.message).toBe("Clicking the button.");
    expect(taskState.iteration).toBe(1);
    expect(taskState.previousActions).toHaveLength(1);
  });

  it("fails safely when fake provider returns unsafe coordinates", async () => {
    const provider: AiProvider = {
      name: "mock",
      async complete(): Promise<AiCompletionResponse> {
        return {
          content: JSON.stringify({
            status: "ACTION_REQUIRED",
            reasoning_summary: "Clicking edge.",
            actions: [{ type: "CLICK", x: 1920, y: 500, button: "left" }],
            message: "Clicking.",
          }),
          model: "mock",
        };
      },
    };

    const orchestrator = new Orchestrator({
      provider,
      config: { model: "mock", openRouterApiKey: "unused" },
    });

    const { response } = await orchestrator.planNextAction({
      userInstruction: "Click something",
      screenshot,
    });

    expect(response.status).toBe("FAILED");
    expect(response.actions).toEqual([]);
  });
});
