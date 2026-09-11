/**
 * cloud.ts — BYOK / self-hosted Anthropic-family providers.
 *
 * Each uses the *dedicated* client class for its platform — never the
 * first-party `Anthropic` client with a `base_url` override pointed at
 * Bedrock/Vertex. All four expose the same `messages.parse`/`messages.countTokens`
 * surface, so they share `fromAnthropicClient` (anthropic.ts).
 */

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { AnthropicFoundry } from "@anthropic-ai/foundry-sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";

import { DEFAULT_MODEL, disabledProvider, fromAnthropicClient } from "./anthropic.js";
import type { LlmProvider } from "./types.js";

export interface BedrockOptions {
  model?: string | undefined;
  awsRegion?: string | undefined;
  timeoutMs?: number | undefined;
  /** injected env (defaults to process.env) — for tests. */
  env?: NodeJS.ProcessEnv | undefined;
}

export function createBedrockProvider(opts: BedrockOptions): LlmProvider {
  const model = opts.model ?? DEFAULT_MODEL;
  const env = opts.env ?? process.env;
  const region = opts.awsRegion ?? env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"];
  // No region ⇒ don't even construct the client: it throws synchronously
  // without one, and every other provider degrades to enabled:false instead.
  if (!region) return disabledProvider("bedrock", model);
  try {
    const client = new AnthropicBedrockMantle({ awsRegion: region, timeout: opts.timeoutMs });
    return fromAnthropicClient("bedrock", client, model, true);
  } catch {
    return disabledProvider("bedrock", model);
  }
}

export interface VertexOptions {
  model?: string | undefined;
  projectId?: string | undefined;
  region?: string | undefined;
  timeoutMs?: number | undefined;
  /** injected env (defaults to process.env) — for tests. */
  env?: NodeJS.ProcessEnv | undefined;
}

export function createVertexProvider(opts: VertexOptions): LlmProvider {
  const model = opts.model ?? DEFAULT_MODEL;
  const env = opts.env ?? process.env;
  const projectId = opts.projectId ?? env["ANTHROPIC_VERTEX_PROJECT_ID"];
  // No project id ⇒ don't construct the client: it starts an async ADC
  // credential probe the instant it's built, which can crash the process with
  // an unhandled rejection when nothing is configured yet.
  if (!projectId) return disabledProvider("vertex", model);
  const region = opts.region ?? env["CLOUD_ML_REGION"] ?? "global";
  try {
    const client = new AnthropicVertex({ projectId, region, timeout: opts.timeoutMs });
    return fromAnthropicClient("vertex", client, model, true);
  } catch {
    return disabledProvider("vertex", model);
  }
}

export interface FoundryOptions {
  model?: string | undefined;
  resource?: string | undefined;
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
  /** injected env (defaults to process.env) — for tests. */
  env?: NodeJS.ProcessEnv | undefined;
}

export function createFoundryProvider(opts: FoundryOptions): LlmProvider {
  const model = opts.model ?? DEFAULT_MODEL;
  const env = opts.env ?? process.env;
  const resource = opts.resource ?? env["ANTHROPIC_FOUNDRY_RESOURCE"];
  const apiKey = opts.apiKey ?? env["ANTHROPIC_FOUNDRY_API_KEY"];
  // Missing either ⇒ don't construct: it throws synchronously without both.
  if (!resource || !apiKey) return disabledProvider("foundry", model);
  try {
    const client = new AnthropicFoundry({ resource, apiKey, timeout: opts.timeoutMs });
    return fromAnthropicClient("foundry", client, model, true);
  } catch {
    return disabledProvider("foundry", model);
  }
}

export interface CustomOptions {
  model?: string | undefined;
  baseUrl: string;
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
}

/**
 * A self-hosted Anthropic-API-compatible endpoint: the first-party
 * client with `baseURL` overridden — this is the one case where that pattern is
 * correct, because the wire protocol is the real Anthropic Messages API.
 */
export function createCustomProvider(opts: CustomOptions): LlmProvider {
  const model = opts.model ?? DEFAULT_MODEL;
  if (!opts.baseUrl) return disabledProvider("custom", model);
  try {
    const client = new Anthropic({
      baseURL: opts.baseUrl,
      apiKey: opts.apiKey ?? "not-needed",
      timeout: opts.timeoutMs,
    });
    return fromAnthropicClient("custom", client, model, true);
  } catch {
    return disabledProvider("custom", model);
  }
}
