import { describe, expect, it } from "vitest";
import {
  extractJsonObject,
  isCoordinateInBounds,
  toImageDataUrl,
  createId,
} from "../src/utils/index.js";
import { loadConfig, assertProviderCredentials } from "../src/utils/config.js";

describe("utils", () => {
  it("checks coordinate bounds (exclusive upper bound)", () => {
    expect(isCoordinateInBounds(0, 0, 1920, 1080)).toBe(true);
    expect(isCoordinateInBounds(1919, 1079, 1920, 1080)).toBe(true);
    expect(isCoordinateInBounds(1920, 0, 1920, 1080)).toBe(false);
    expect(isCoordinateInBounds(1920, 500, 1920, 1080)).toBe(false);
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

  it("extracts plain JSON", () => {
    const parsed = extractJsonObject(
      '{"status":"COMPLETED","reasoning_summary":"done","actions":[],"message":"ok"}',
    ) as { status: string };
    expect(parsed.status).toBe("COMPLETED");
  });

  it("extracts JSON from fenced model output", () => {
    const raw =
      'Sure.\n```json\n{"status":"COMPLETED","reasoning_summary":"done","actions":[{"type":"DONE","params":{}}],"message":"ok"}\n```';
    const parsed = extractJsonObject(raw) as { status: string };
    expect(parsed.status).toBe("COMPLETED");
  });

  it("extracts JSON surrounded by prose", () => {
    const raw =
      'Here is the plan:\n{"status":"ACTION_REQUIRED","reasoning_summary":"go","actions":[{"type":"WAIT","params":{"ms":100}}],"message":"wait"}\nThanks.';
    const parsed = extractJsonObject(raw) as { status: string };
    expect(parsed.status).toBe("ACTION_REQUIRED");
  });

  it("rejects malformed JSON", () => {
    expect(() => extractJsonObject("not json at all")).toThrow(/Unable to extract/);
    expect(() => extractJsonObject("{broken")).toThrow(/Unable to extract/);
    expect(() => extractJsonObject("")).toThrow(/empty/);
  });

  it("creates unique ids", () => {
    expect(createId("task")).not.toBe(createId("task"));
  });

  it("loads config with OpenRouter defaults and timeout", () => {
    const config = loadConfig({
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
      maxIterations: 10,
      maxSameActionRetries: 2,
      timeoutMs: 45_000,
      openRouterApiKey: "test-key",
    });
    expect(config.provider).toBe("openrouter");
    expect(config.maxIterations).toBe(10);
    expect(config.timeoutMs).toBe(45_000);
    expect(config.openRouterAppName).toBe("PetAI Computer Agent");
  });

  it("requires provider credentials only for selected provider", () => {
    expect(() =>
      assertProviderCredentials({
        provider: "openrouter",
        model: "google/gemini-2.5-flash",
        maxIterations: 30,
        maxSameActionRetries: 3,
        timeoutMs: 60_000,
      }),
    ).toThrow(/OPENROUTER_API_KEY/);

    expect(() =>
      assertProviderCredentials({
        provider: "gemini",
        model: "gemini-2.0-flash",
        maxIterations: 30,
        maxSameActionRetries: 3,
        timeoutMs: 60_000,
        geminiApiKey: "ok",
      }),
    ).not.toThrow();
  });
});
