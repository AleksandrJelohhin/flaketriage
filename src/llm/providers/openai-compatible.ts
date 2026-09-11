/**
 * openai-compatible.ts — one provider covering Gemini, OpenAI, and any local
 * OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM).
 *
 * Raw `fetch` to `{baseUrl}/chat/completions` with a JSON-schema response format.
 * No SDK dependency. There is no universal token-count endpoint, so the guardrail
 * uses a chars/4 estimate here (Anthropic uses the real countTokens).
 */

import { LlmError } from "../../core/errors.js";
import { TriageResponseSchema, triageJsonSchema } from "../schema.js";
import type { ModelVerdict } from "../schema.js";
import type { LlmCallResult, LlmProvider, ProviderName } from "./types.js";

export interface OpenAiCompatOptions {
  name: ProviderName;
  model: string;
  baseUrl: string;
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
  /** USD per 1M tokens; omit / 0 for local + free tiers. */
  rateInput?: number;
  rateOutput?: number;
}

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

export function createOpenAiCompatProvider(opts: OpenAiCompatOptions): LlmProvider {
  const url = `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const rateIn = opts.rateInput ?? 0;
  const rateOut = opts.rateOutput ?? 0;
  // `local` and an explicitly-pointed `openai-compatible` server (llama.cpp,
  // Ollama, LM Studio, vLLM) usually need no key; the cloud presets do.
  const keyless = opts.name === "local" || opts.name === "openai-compatible";

  return {
    name: opts.name,
    model: opts.model,
    enabled: keyless || Boolean(opts.apiKey),

    async countTokens(system, userPayload) {
      return estimateTokens(system) + estimateTokens(userPayload);
    },

    async triage(system, userPayload): Promise<LlmCallResult> {
      const controller = new AbortController();
      const timer = opts.timeoutMs
        ? setTimeout(() => controller.abort(), opts.timeoutMs)
        : null;

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: opts.model,
            temperature: 0,
            messages: [
              { role: "system", content: system },
              { role: "user", content: userPayload },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: "triage", strict: true, schema: triageJsonSchema() },
            },
          }),
        });
      } catch (cause) {
        throw new LlmError(`${opts.name}: request to ${url} failed`, { cause });
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new LlmError(
          `${opts.name}: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ""}`,
        );
      }

      let json: ChatCompletion;
      try {
        json = (await res.json()) as ChatCompletion;
      } catch (cause) {
        throw new LlmError(`${opts.name}: response was not JSON`, { cause });
      }

      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new LlmError(`${opts.name}: empty completion`);

      let parsed: { verdicts: ModelVerdict[] };
      try {
        parsed = TriageResponseSchema.parse(JSON.parse(content));
      } catch (cause) {
        throw new LlmError(`${opts.name}: model output did not match the triage schema`, {
          cause,
        });
      }

      const inputTokens = json.usage?.prompt_tokens ?? estimateTokens(system + userPayload);
      const outputTokens = json.usage?.completion_tokens ?? estimateTokens(content);

      return {
        verdicts: parsed.verdicts,
        usage: { inputTokens, outputTokens, cachedInputTokens: 0 },
        usd: (inputTokens / 1e6) * rateIn + (outputTokens / 1e6) * rateOut,
        cacheHit: false,
        model: opts.model,
      };
    },
  };
}
