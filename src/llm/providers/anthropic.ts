/**
 * anthropic.ts — the default escalation provider, and the shared
 * implementation every Anthropic-family provider (Bedrock/Vertex/Foundry/custom,
 * see `cloud.ts`) is built from — they all expose the same
 * `messages.parse` / `messages.countTokens` surface.
 *
 * Uses `client.messages.parse` with a zod output format, a frozen cached system
 * prompt, and `client.messages.countTokens` for the pre-flight token guardrail.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { LlmError } from "../../core/errors.js";
import { TriageResponseSchema } from "../schema.js";
import type { ModelVerdict } from "../schema.js";
import type { LlmCallResult, LlmProvider, ProviderName } from "./types.js";

export const DEFAULT_MODEL = "claude-opus-5";
const MAX_TOKENS = 16_000;

// Opus 5 rates, USD per 1M tokens. Cloud-hosted rates may differ in
// practice; this stays the estimate baseline across every Anthropic-family provider.
const RATE_INPUT = 5;
const RATE_OUTPUT = 25;
const RATE_CACHE_READ = 0.5;
const RATE_CACHE_WRITE = 6.25;

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** The subset of the SDK client every Anthropic-family provider needs. */
export interface AnthropicLikeClient {
  messages: {
    parse: Anthropic["messages"]["parse"];
    countTokens: Anthropic["messages"]["countTokens"];
  };
}

/** Build an `LlmProvider` from an already-constructed Anthropic-family client. */
export function fromAnthropicClient(
  name: ProviderName,
  client: AnthropicLikeClient,
  model: string,
  enabled: boolean,
): LlmProvider {
  return {
    name,
    model,
    enabled,

    async countTokens(system, userPayload) {
      try {
        const r = await client.messages.countTokens({
          model,
          system: [{ type: "text", text: system }],
          messages: [{ role: "user", content: userPayload }],
        });
        return r.input_tokens;
      } catch (cause) {
        throw new LlmError(`${name}: countTokens failed`, { cause });
      }
    },

    async triage(system, userPayload): Promise<LlmCallResult> {
      let response;
      try {
        response = await client.messages.parse({
          model,
          max_tokens: MAX_TOKENS,
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: userPayload }],
          output_config: { format: zodOutputFormat(TriageResponseSchema) },
        });
      } catch (cause) {
        throw new LlmError(`${name}: request failed`, { cause });
      }

      if (!response.parsed_output) {
        throw new LlmError(`${name}: model returned unparseable output`);
      }

      const verdicts: ModelVerdict[] = response.parsed_output.verdicts;
      const u = (response.usage ?? {}) as AnthropicUsage;
      const inputTokens = u.input_tokens ?? 0;
      const outputTokens = u.output_tokens ?? 0;
      const cachedInputTokens = u.cache_read_input_tokens ?? 0;
      const cacheCreation = u.cache_creation_input_tokens ?? 0;
      const freshInput = Math.max(inputTokens - cachedInputTokens - cacheCreation, 0);

      const usd =
        (freshInput / 1e6) * RATE_INPUT +
        (cachedInputTokens / 1e6) * RATE_CACHE_READ +
        (cacheCreation / 1e6) * RATE_CACHE_WRITE +
        (outputTokens / 1e6) * RATE_OUTPUT;

      return {
        verdicts,
        usage: { inputTokens, outputTokens, cachedInputTokens },
        usd,
        cacheHit: cachedInputTokens > 0,
        model,
      };
    },
  };
}

/**
 * A provider with no usable client — missing region/project/resource/key.
 * Reports `enabled: false` and never touches the network or constructs the
 * real SDK client (some of those, e.g. Vertex, start an async credential probe
 * the instant they're constructed — this stays inert until actually enabled).
 * Callers must check `.enabled` before calling `triage`/`countTokens`, same
 * contract as every other provider; these reject defensively if called anyway.
 */
export function disabledProvider(name: ProviderName, model: string): LlmProvider {
  const reason = `${name}: not configured`;
  return {
    name,
    model,
    enabled: false,
    async countTokens() {
      throw new LlmError(reason);
    },
    async triage() {
      throw new LlmError(reason);
    },
  };
}

export function createAnthropicProvider(opts: {
  model?: string | undefined;
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
}): LlmProvider {
  const model = opts.model ?? DEFAULT_MODEL;
  const apiKey =
    opts.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? process.env["ANTHROPIC_AUTH_TOKEN"];
  const client = new Anthropic(
    apiKey ? { apiKey, timeout: opts.timeoutMs } : { timeout: opts.timeoutMs },
  );
  return fromAnthropicClient("anthropic", client, model, Boolean(apiKey));
}
