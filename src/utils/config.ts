import { config as loadDotenv } from "dotenv";
import type { AiProviderName, OrchestratorConfig } from "../types/index.js";

loadDotenv();

function requirePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return n;
}

function parseProvider(value: string | undefined): AiProviderName {
  const v = (value ?? "openrouter").toLowerCase().trim();
  if (v === "openrouter" || v === "gemini") {
    return v;
  }
  throw new Error(
    `AI_PROVIDER must be "openrouter" or "gemini", got: ${value}`,
  );
}

/**
 * Load orchestrator configuration from environment variables.
 * Never hardcodes API keys.
 */
export function loadConfig(
  overrides: Partial<OrchestratorConfig> = {},
): OrchestratorConfig {
  const provider = overrides.provider ?? parseProvider(process.env.AI_PROVIDER);
  const model =
    overrides.model ??
    process.env.AI_MODEL ??
    (provider === "gemini" ? "gemini-2.0-flash" : "openai/gpt-4o");

  return {
    provider,
    model,
    maxIterations:
      overrides.maxIterations ??
      requirePositiveInt(process.env.MAX_AGENT_ITERATIONS, 30),
    maxSameActionRetries:
      overrides.maxSameActionRetries ??
      requirePositiveInt(process.env.MAX_SAME_ACTION_RETRIES, 3),
    openRouterApiKey:
      overrides.openRouterApiKey ?? process.env.OPENROUTER_API_KEY,
    geminiApiKey: overrides.geminiApiKey ?? process.env.GEMINI_API_KEY,
    openRouterBaseUrl:
      overrides.openRouterBaseUrl ?? process.env.OPENROUTER_BASE_URL,
    geminiBaseUrl: overrides.geminiBaseUrl ?? process.env.GEMINI_BASE_URL,
  };
}

export function assertProviderCredentials(config: OrchestratorConfig): void {
  if (config.provider === "openrouter" && !config.openRouterApiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is required when AI_PROVIDER=openrouter",
    );
  }
  if (config.provider === "gemini" && !config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required when AI_PROVIDER=gemini");
  }
}
