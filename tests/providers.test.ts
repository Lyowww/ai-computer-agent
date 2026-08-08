import { describe, expect, it, vi } from "vitest";
import { OpenRouterProvider } from "../src/ai/providers/openrouter.js";
import { GeminiProvider } from "../src/ai/providers/gemini.js";
import { createAiProvider } from "../src/ai/providers/index.js";
import { ProviderError } from "../src/ai/errors.js";

describe("AI providers", () => {
  it("OpenRouter maps vision messages, auth header, and model selection", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "google/gemini-2.5-flash",
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
            usage: {
              prompt_tokens: 10,
              completion_tokens: 20,
              total_tokens: 30,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const provider = new OpenRouterProvider({
      apiKey: "test-key",
      siteUrl: "https://example.com",
      siteName: "PetAI Computer Agent",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 1,
    });

    const result = await provider.complete({
      model: "google/gemini-2.5-flash",
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
    expect(result.model).toBe("google/gemini-2.5-flash");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers["HTTP-Referer"]).toBe("https://example.com");
    expect(headers["X-Title"]).toBe("PetAI Computer Agent");

    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("google/gemini-2.5-flash");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[1].content[1].type).toBe("image_url");
    expect(body.messages[1].content[1].image_url.url).toBe(
      "data:image/png;base64,aaa",
    );
  });

  it("Gemini uses inlineData and systemInstruction", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: '{"status":"COMPLETED","reasoning_summary":"done","actions":[{"type":"DONE","params":{}}],"message":"ok"}',
                    },
                  ],
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
      maxRetries: 1,
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

  it("maps 401 to ProviderError UNAUTHORIZED", async () => {
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
      maxRetries: 1,
    });
    await expect(
      provider.complete({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "UNAUTHORIZED",
      status: 401,
      retryable: false,
    });
  });

  it("maps 429 as retryable rate limit", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 3) {
        return new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
          model: "m",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const provider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 3,
    });

    const result = await provider.complete({
      model: "google/gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.content).toContain("ok");
    expect(calls).toBe(3);
  });

  it("maps 5xx as retryable server error and eventually fails", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "boom" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const provider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 2,
    });

    await expect(
      provider.complete({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toMatchObject({
      code: "SERVER_ERROR",
      status: 503,
      retryable: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed empty completion content", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const provider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 1,
    });
    await expect(
      provider.complete({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("times out with ProviderError TIMEOUT", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
        }),
    );

    const provider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 20,
      maxRetries: 1,
    });

    await expect(
      provider.complete({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "TIMEOUT",
      retryable: true,
    });
    expect(ProviderError).toBeDefined();
  });

  it("does not require missing key until construction", () => {
    expect(
      () => new OpenRouterProvider({ apiKey: "" }),
    ).toThrow(/OPENROUTER_API_KEY/);
  });
});
