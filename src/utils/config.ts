import { config as loadDotenv } from "dotenv";
import type { AiProviderName, OrchestratorConfig } from "../types/index.js";

loadDotenv();

const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash";
const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";
const DEFAULT_TIMEOUT_MS = 60_000;

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

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Load orchestrator configuration from environment variables.
 * Never hardcodes API keys. Provider-specific keys are only required
 * when that provider is selected (see assertProviderCredentials).
 */
export function loadConfig(
  overrides: Partial<OrchestratorConfig> = {},
): OrchestratorConfig {
  const provider = overrides.provider ?? parseProvider(readEnv("AI_PROVIDER"));
  const model =
    overrides.model ??
    readEnv("AI_MODEL") ??
    (provider === "gemini" ? DEFAULT_GEMINI_MODEL : DEFAULT_OPENROUTER_MODEL);

  return {
    provider,
    model,
    maxIterations:
      overrides.maxIterations ??
      requirePositiveInt(readEnv("MAX_AGENT_ITERATIONS"), 30),
    maxSameActionRetries:
      overrides.maxSameActionRetries ??
      requirePositiveInt(readEnv("MAX_SAME_ACTION_RETRIES"), 3),
    timeoutMs:
      overrides.timeoutMs ??
      requirePositiveInt(readEnv("AI_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS),
    openRouterApiKey:
      overrides.openRouterApiKey ?? readEnv("OPENROUTER_API_KEY"),
    geminiApiKey: overrides.geminiApiKey ?? readEnv("GEMINI_API_KEY"),
    openRouterBaseUrl:
      overrides.openRouterBaseUrl ?? readEnv("OPENROUTER_BASE_URL"),
    geminiBaseUrl: overrides.geminiBaseUrl ?? readEnv("GEMINI_BASE_URL"),
    openRouterHttpReferer:
      overrides.openRouterHttpReferer ?? readEnv("OPENROUTER_HTTP_REFERER"),
    openRouterAppName:
      overrides.openRouterAppName ??
      readEnv("OPENROUTER_APP_NAME") ??
      "PetAI Computer Agent",
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
