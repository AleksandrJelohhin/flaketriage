import { afterEach, describe, expect, it, vi } from "vitest";

import { LlmError } from "../../src/core/errors.js";
import { createOpenAiCompatProvider } from "../../src/llm/providers/openai-compatible.js";

const goodVerdict = {
  test_key: "k1",
  kind: "flake_likely",
  confidence: "medium",
  one_line_reason: "timeout with no code link",
  likely_cause: "slow CI runner",
  suspect_location: null,
  suggested_next_step: "re-run; add an explicit wait",
};

function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) =>
      Promise.resolve(impl(String(input), (init ?? {}) as RequestInit)),
    );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("openai-compatible provider", () => {
  it("posts a json_schema request with a bearer token and parses the completion", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    let seenAuth: string | null = null;
    mockFetch((url, init) => {
      seenUrl = url;
      seenAuth = new Headers(init.headers).get("authorization");
      seenBody = JSON.parse(String(init.body));
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({ verdicts: [goodVerdict] }) } }],
        usage: { prompt_tokens: 1200, completion_tokens: 90 },
      });
    });

    const p = createOpenAiCompatProvider({
      name: "gemini",
      model: "gemini-2.5-flash",
      baseUrl: "https://example.test/v1/",
      apiKey: "AIza-secret",
      rateInput: 0,
      rateOutput: 0,
    });
    const res = await p.triage("SYS", "PAYLOAD");

    expect(seenUrl).toBe("https://example.test/v1/chat/completions");
    expect(seenAuth).toBe("Bearer AIza-secret");
    expect(seenBody["model"]).toBe("gemini-2.5-flash");
    expect(seenBody["temperature"]).toBe(0);
    expect((seenBody["response_format"] as { type: string }).type).toBe("json_schema");
    expect(res.verdicts[0]).toMatchObject({ test_key: "k1", kind: "flake_likely" });
    expect(res.usage).toMatchObject({ inputTokens: 1200, outputTokens: 90, cachedInputTokens: 0 });
    expect(res.usd).toBe(0);
    expect(res.cacheHit).toBe(false);
  });

  it("computes USD from token usage and rates", async () => {
    mockFetch(() =>
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({ verdicts: [goodVerdict] }) } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      }),
    );
    const p = createOpenAiCompatProvider({
      name: "openai",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.test/v1",
      apiKey: "sk-x",
      rateInput: 0.15,
      rateOutput: 0.6,
    });
    const res = await p.triage("s", "p");
    expect(res.usd).toBeCloseTo(0.75);
  });

  it("omits the Authorization header for a local server with no key", async () => {
    let auth: string | null = "unset";
    mockFetch((_url, init) => {
      auth = new Headers(init.headers).get("authorization");
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({ verdicts: [] }) } }],
      });
    });
    const p = createOpenAiCompatProvider({
      name: "local",
      model: "qwen2.5",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(p.enabled).toBe(true);
    await p.triage("s", "p");
    expect(auth).toBeNull();
  });

  it("throws a typed LlmError on a non-2xx response", async () => {
    mockFetch(() => new Response("rate limited", { status: 429 }));
    const p = createOpenAiCompatProvider({
      name: "gemini",
      model: "m",
      baseUrl: "https://x.test/v1",
      apiKey: "k",
    });
    await expect(p.triage("s", "p")).rejects.toBeInstanceOf(LlmError);
  });

  it("throws when the completion does not match the triage schema", async () => {
    mockFetch(() =>
      jsonResponse({ choices: [{ message: { content: JSON.stringify({ nope: true }) } }] }),
    );
    const p = createOpenAiCompatProvider({
      name: "local",
      model: "m",
      baseUrl: "http://localhost:11434/v1",
    });
    await expect(p.triage("s", "p")).rejects.toThrow(/did not match the triage schema/);
  });

  it("countTokens uses a chars/4 estimate", async () => {
    const p = createOpenAiCompatProvider({
      name: "local",
      model: "m",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(await p.countTokens("a".repeat(40), "b".repeat(40))).toBe(20);
  });
});
