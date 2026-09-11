/**
 * Provider abstraction for the LLM escalation layer.
 *
 * FlakeTriage's default is Anthropic. `bedrock` / `vertex` / `foundry`
 * / `custom` are the BYOK / self-hosted paths the Self-Hosted tier depends on
 * — each uses its dedicated Anthropic SDK client class. `gemini` /
 * `openai` / `local` are OpenAI-compatible endpoints kept so the tool can be
 * exercised for free during development.
 */

import type { ModelVerdict } from "../schema.js";

export type ProviderName =
  | "anthropic"
  | "bedrock"
  | "vertex"
  | "foundry"
  | "custom"
  | "gemini"
  | "openai"
  | "local"
  | "openai-compatible";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** tokens served from the prompt cache (Anthropic only; 0 elsewhere). */
  cachedInputTokens: number;
}

export interface LlmCallResult {
  verdicts: ModelVerdict[];
  usage: LlmUsage;
  /** estimated USD cost of this call (0 for local / free tiers). */
  usd: number;
  /** true when the cached system-prompt prefix was reused. */
  cacheHit: boolean;
  /** model id actually used. */
  model: string;
}

export interface LlmProvider {
  readonly name: ProviderName;
  readonly model: string;
  /** True when the tool need not hit the network (e.g. no key configured). */
  readonly enabled: boolean;
  /**
   * Send one batched request and return one verdict per input failure.
   * `estimateOnly` returns token estimates without calling the model — used to
   * enforce the 100K-token guardrail before spending money.
   */
  triage(system: string, userPayload: string): Promise<LlmCallResult>;
  countTokens(system: string, userPayload: string): Promise<number>;
}

export interface LlmConfig {
  provider: ProviderName;
  model: string;
  /** base URL for OpenAI-compatible providers. */
  baseUrl?: string;
  apiKey?: string;
  /** request timeout ms. */
  timeoutMs?: number;
}
