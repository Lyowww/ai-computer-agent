import { describe, expect, it } from "vitest";
import {
  extractJsonObject,
  isCoordinateInBounds,
  toImageDataUrl,
  createId,
} from "../src/utils/index.js";
import { loadConfig } from "../src/utils/config.js";

describe("utils", () => {
  it("checks coordinate bounds", () => {
    expect(isCoordinateInBounds(0, 0, 1920, 1080)).toBe(true);
    expect(isCoordinateInBounds(1919, 1079, 1920, 1080)).toBe(true);
    expect(isCoordinateInBounds(1920, 0, 1920, 1080)).toBe(false);
    expect(isCoordinateInBounds(-1, 10, 1920, 1080)).toBe(false);
  });

  it("normalizes image data URLs", () => {
    expect(toImageDataUrl({ width: 1, height: 1, image: "abc123" })).toBe(
      "data:image/png;base64,abc123",
    );
    expect(
      toImageDataUrl({
        width: 1,
        height: 1,
        image: "data:image/jpeg;base64,xyz",
      }),
    ).toBe("data:image/jpeg;base64,xyz");
  });

  it("extracts JSON from fenced model output", () => {
    const raw = 'Sure.\n```json\n{"status":"COMPLETED","reasoning_summary":"done","actions":[{"type":"DONE","params":{}}],"message":"ok"}\n```';
    const parsed = extractJsonObject(raw) as { status: string };
    expect(parsed.status).toBe("COMPLETED");
  });

  it("creates unique ids", () => {
    expect(createId("task")).not.toBe(createId("task"));
  });

  it("loads config with overrides", () => {
    const config = loadConfig({
      provider: "gemini",
      model: "gemini-2.0-flash",
      maxIterations: 10,
      maxSameActionRetries: 2,
      geminiApiKey: "test-key",
    });
    expect(config.provider).toBe("gemini");
    expect(config.maxIterations).toBe(10);
  });
});
