import { describe, expect, it, vi } from "vitest";
import { OpenRouterProvider } from "../src/ai/providers/openrouter.js";
import { GeminiProvider } from "../src/ai/providers/gemini.js";
import { createAiProvider } from "../src/ai/providers/index.js";

describe("AI providers", () => {
  it("OpenRouter maps vision messages and parses completion", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          model: "openai/gpt-4o",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  status: "ACTION_REQUIRED",
                  reasoning_summary: "Click address bar",
                  actions: [{ type: "CLICK", params: { x: 400, y: 60 } }],
                  message: "Clicking the address bar",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const provider = new OpenRouterProvider({
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.complete({
      model: "openai/gpt-4o",
      messages: [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", url: "data:image/png;base64,aaa" },
          ],
        },
      ],
      responseFormat: "json_object",
    });

    expect(result.content).toContain("ACTION_REQUIRED");
    expect(result.usage?.totalTokens).toBe(30);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[1].content[1].type).toBe("image_url");
  });

  it("Gemini uses inlineData and systemInstruction", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"status":"COMPLETED","reasoning_summary":"done","actions":[{"type":"DONE","params":{}}],"message":"ok"}' }],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 7,
            totalTokenCount: 12,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const provider = new GeminiProvider({
      apiKey: "gemini-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.complete({
      model: "gemini-2.0-flash",
      messages: [
        { role: "system", content: "be careful" },
        {
          role: "user",
          content: [
            { type: "text", text: "screenshot" },
            { type: "image", url: "data:image/png;base64,qqq" },
          ],
        },
      ],
      responseFormat: "json_object",
    });

    expect(result.content).toContain("COMPLETED");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("gemini-2.0-flash");
    expect(url).toContain("key=gemini-key");
    const body = JSON.parse(String(init.body));
    expect(body.systemInstruction.parts[0].text).toBe("be careful");
    expect(body.contents[0].parts[1].inlineData.data).toBe("qqq");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });

  it("factory creates the selected provider", () => {
    const openrouter = createAiProvider({
      provider: "openrouter",
      openRouterApiKey: "k",
    });
    expect(openrouter.name).toBe("openrouter");

    const gemini = createAiProvider({
      provider: "gemini",
      geminiApiKey: "k",
    });
    expect(gemini.name).toBe("gemini");
  });

  it("surfaces API errors", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "bad key" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const provider = new OpenRouterProvider({
      apiKey: "bad",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      provider.complete({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/OpenRouter API error/);
  });
});
