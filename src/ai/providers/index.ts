import type { AiProvider, AiProviderName, OrchestratorConfig } from "../../types/index.js";
import { OpenRouterProvider } from "./openrouter.js";
import { GeminiProvider } from "./gemini.js";

export interface CreateProviderOptions {
  provider: AiProviderName;
  openRouterApiKey?: string;
  geminiApiKey?: string;
  openRouterBaseUrl?: string;
  geminiBaseUrl?: string;
  openRouterHttpReferer?: string;
  openRouterAppName?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Factory: create an AI provider from configuration without coupling the orchestrator
 * to a specific vendor.
 */
export function createAiProvider(options: CreateProviderOptions): AiProvider {
  switch (options.provider) {
    case "openrouter":
      return new OpenRouterProvider({
        apiKey: options.openRouterApiKey ?? "",
        baseUrl: options.openRouterBaseUrl,
        fetchImpl: options.fetchImpl,
        siteUrl: options.openRouterHttpReferer,
        siteName: options.openRouterAppName ?? "PetAI Computer Agent",
        timeoutMs: options.timeoutMs,
      });
    case "gemini":
      return new GeminiProvider({
        apiKey: options.geminiApiKey ?? "",
        baseUrl: options.geminiBaseUrl,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });
    default: {
      const _exhaustive: never = options.provider;
      throw new Error(`Unsupported AI provider: ${String(_exhaustive)}`);
    }
  }
}

export function createAiProviderFromConfig(
  config: OrchestratorConfig,
  fetchImpl?: typeof fetch,
): AiProvider {
  return createAiProvider({
    provider: config.provider,
    openRouterApiKey: config.openRouterApiKey,
    geminiApiKey: config.geminiApiKey,
    openRouterBaseUrl: config.openRouterBaseUrl,
    geminiBaseUrl: config.geminiBaseUrl,
    openRouterHttpReferer: config.openRouterHttpReferer,
    openRouterAppName: config.openRouterAppName,
    timeoutMs: config.timeoutMs,
    fetchImpl,
  });
}

export { OpenRouterProvider } from "./openrouter.js";
export { GeminiProvider } from "./gemini.js";
