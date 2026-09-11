import { describe, expect, it } from "vitest";

import { createAnthropicProvider } from "../../src/llm/providers/anthropic.js";
import { SYSTEM_PROMPT } from "../../src/llm/prompt.js";

/**
 * Live integration test — runs only when ANTHROPIC_API_KEY is set. Verifies the
 * frozen system prompt is actually being cached: on the second call
 * with the same prefix, `usage.cache_read_input_tokens` must be > 0.
 *
 * Costs a few cents per run. `npm test` skips it in normal development / CI.
 */

const RUN = Boolean(process.env["ANTHROPIC_API_KEY"]);

describe.skipIf(!RUN)("anthropic provider — live", () => {
  it("caches the frozen system prompt across calls", async () => {
    const provider = createAnthropicProvider({});
    const payload = [
      "## Run context",
      "commit: deadbeef",
      "## 1 ambiguous failure(s)",
      "",
      "### test_key: k1",
      "suite: acme.S",
      "name: does a thing",
      "status: failed",
      "message:",
      "Error: connect ETIMEDOUT 10.0.0.5:5432",
      "stack:",
      "at Pool.connect (src/db.ts:20)",
    ].join("\n");

    const first = await provider.triage(SYSTEM_PROMPT, payload);
    expect(first.verdicts).toHaveLength(1);
    expect(first.verdicts[0]!.test_key).toBe("k1");

    const second = await provider.triage(SYSTEM_PROMPT, `${payload}\n(second call)`);
    expect(second.usage.cachedInputTokens).toBeGreaterThan(0);
    expect(second.cacheHit).toBe(true);
  }, 60_000);
});
