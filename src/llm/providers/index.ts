/**
 * index.ts — resolve a provider from CLI flags + environment.
 */

import { createAnthropicProvider } from "./anthropic.js";
import {
  createBedrockProvider,
  createCustomProvider,
  createFoundryProvider,
  createVertexProvider,
} from "./cloud.js";
import { createOpenAiCompatProvider } from "./openai-compatible.js";
import type { LlmProvider, ProviderName } from "./types.js";

export type ProviderChoice = ProviderName | "auto" | "none";

export interface ResolveOptions {
  provider?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
  /** AWS region — `bedrock` only (falls back to AWS_REGION / AWS_DEFAULT_REGION). */
  awsRegion?: string | undefined;
  /** GCP project id — `vertex` only (falls back to ANTHROPIC_VERTEX_PROJECT_ID). */
  gcpProjectId?: string | undefined;
  /** GCP region — `vertex` only (falls back to CLOUD_ML_REGION, default "global"). */
  gcpRegion?: string | undefined;
  /** Azure AI Foundry resource name — `foundry` only (falls back to ANTHROPIC_FOUNDRY_RESOURCE). */
  foundryResource?: string | undefined;
  /** `--no-llm` — force no provider. */
  disabled?: boolean;
  /** injected env (defaults to process.env) — for tests. */
  env?: NodeJS.ProcessEnv;
}

interface Preset {
  baseUrl: string;
  model: string;
  keyEnv: string[];
  rateInput: number;
  rateOutput: number;
}

// Free / cheap defaults chosen for development use.
const PRESETS: Record<"gemini" | "openai" | "local", Preset> = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.6-flash",
    keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    rateInput: 0, // free tier / negligible
    rateOutput: 0,
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    keyEnv: ["OPENAI_API_KEY"],
    rateInput: 0.15,
    rateOutput: 0.6,
  },
  local: {
    baseUrl: "http://localhost:11434/v1", // Ollama default
    model: "qwen2.5",
    keyEnv: [],
    rateInput: 0,
    rateOutput: 0,
  },
};

function firstEnv(env: NodeJS.ProcessEnv, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = env[k];
    if (v) return v;
  }
  return undefined;
}

/**
 * Returns a provider, or `null` when escalation should be skipped (`--no-llm`,
 * `--provider none`, or `auto` with no credentials anywhere).
 */
export function resolveProvider(opts: ResolveOptions = {}): LlmProvider | null {
  if (opts.disabled) return null;

  const env = opts.env ?? process.env;
  const choice = (
    opts.provider ??
    env["FLAKETRIAGE_LLM_PROVIDER"] ??
    "auto"
  ).toLowerCase() as ProviderChoice;
  const model = opts.model ?? env["FLAKETRIAGE_LLM_MODEL"];
  const baseUrl = opts.baseUrl ?? env["FLAKETRIAGE_LLM_BASE_URL"];
  const apiKey = opts.apiKey ?? env["FLAKETRIAGE_LLM_API_KEY"];
  const timeoutMs = opts.timeoutMs ?? 120_000;

  if (choice === "none") return null;

  const anthropicKey = apiKey ?? env["ANTHROPIC_API_KEY"] ?? env["ANTHROPIC_AUTH_TOKEN"];

  if (choice === "auto") {
    if (anthropicKey) {
      return createAnthropicProvider({ model: model ?? undefined, apiKey: anthropicKey, timeoutMs });
    }
    if (firstEnv(env, PRESETS.gemini.keyEnv)) {
      return build("gemini", { model, baseUrl, apiKey, timeoutMs, env });
    }
    if (firstEnv(env, PRESETS.openai.keyEnv)) {
      return build("openai", { model, baseUrl, apiKey, timeoutMs, env });
    }
    return null; // nothing configured — leave ambiguous verdicts as-is
  }

  if (choice === "anthropic") {
    return createAnthropicProvider({ model: model ?? undefined, apiKey: anthropicKey, timeoutMs });
  }
  if (choice === "gemini" || choice === "openai" || choice === "local") {
    return build(choice, { model, baseUrl, apiKey, timeoutMs, env });
  }
  if (choice === "openai-compatible") {
    if (!baseUrl) {
      throw new Error("--provider openai-compatible requires --llm-base-url");
    }
    return createOpenAiCompatProvider({
      name: "openai-compatible",
      model: model ?? "local-model",
      baseUrl,
      apiKey,
      timeoutMs,
    });
  }
  if (choice === "bedrock") {
    return createBedrockProvider({
      model: model ?? undefined,
      awsRegion: opts.awsRegion,
      timeoutMs,
      env,
    });
  }
  if (choice === "vertex") {
    return createVertexProvider({
      model: model ?? undefined,
      projectId: opts.gcpProjectId,
      region: opts.gcpRegion,
      timeoutMs,
      env,
    });
  }
  if (choice === "foundry") {
    return createFoundryProvider({
      model: model ?? undefined,
      resource: opts.foundryResource,
      apiKey,
      timeoutMs,
      env,
    });
  }
  if (choice === "custom") {
    if (!baseUrl) {
      throw new Error("--provider custom requires --llm-base-url");
    }
    return createCustomProvider({
      model: model ?? undefined,
      baseUrl,
      apiKey,
      timeoutMs,
    });
  }
  throw new Error(`unknown --provider "${choice}"`);
}

function build(
  name: "gemini" | "openai" | "local",
  o: {
    model?: string | undefined;
    baseUrl?: string | undefined;
    apiKey?: string | undefined;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
  },
): LlmProvider {
  const preset = PRESETS[name];
  return createOpenAiCompatProvider({
    name,
    model: o.model ?? preset.model,
    baseUrl: o.baseUrl ?? preset.baseUrl,
    apiKey: o.apiKey ?? firstEnv(o.env, preset.keyEnv),
    timeoutMs: o.timeoutMs,
    rateInput: preset.rateInput,
    rateOutput: preset.rateOutput,
  });
}

export type { LlmProvider } from "./types.js";
