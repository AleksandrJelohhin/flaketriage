import { describe, expect, it } from "vitest";

import { resolveProvider } from "../../src/llm/providers/index.js";

const noEnv: NodeJS.ProcessEnv = {};

describe("resolveProvider", () => {
  it("--no-llm / disabled → null regardless of keys", () => {
    expect(
      resolveProvider({ disabled: true, env: { ANTHROPIC_API_KEY: "x" } }),
    ).toBeNull();
  });

  it("provider 'none' → null", () => {
    expect(resolveProvider({ provider: "none", env: { ANTHROPIC_API_KEY: "x" } })).toBeNull();
  });

  it("auto → anthropic when ANTHROPIC_API_KEY is set", () => {
    const p = resolveProvider({ provider: "auto", env: { ANTHROPIC_API_KEY: "sk-ant" } });
    expect(p?.name).toBe("anthropic");
    expect(p?.model).toBe("claude-opus-5");
    expect(p?.enabled).toBe(true);
  });

  it("auto → gemini when only a Google key is set", () => {
    const p = resolveProvider({ provider: "auto", env: { GEMINI_API_KEY: "AIza" } });
    expect(p?.name).toBe("gemini");
    expect(p?.model).toBe("gemini-3.6-flash");
  });

  it("auto → openai when only OPENAI_API_KEY is set", () => {
    const p = resolveProvider({ provider: "auto", env: { OPENAI_API_KEY: "sk" } });
    expect(p?.name).toBe("openai");
  });

  it("auto → null when nothing is configured", () => {
    expect(resolveProvider({ provider: "auto", env: noEnv })).toBeNull();
  });

  it("explicit gemini without a key → provider exists but not enabled", () => {
    const p = resolveProvider({ provider: "gemini", env: noEnv });
    expect(p?.name).toBe("gemini");
    expect(p?.enabled).toBe(false);
  });

  it("explicit local → enabled without any key, Ollama default base URL", () => {
    const p = resolveProvider({ provider: "local", env: noEnv });
    expect(p?.name).toBe("local");
    expect(p?.enabled).toBe(true);
    expect(p?.model).toBe("qwen2.5");
  });

  it("--llm-model / --llm-base-url override the preset", () => {
    const p = resolveProvider({
      provider: "local",
      model: "llama3.1",
      baseUrl: "http://127.0.0.1:1234/v1",
      env: noEnv,
    });
    expect(p?.model).toBe("llama3.1");
  });

  it("openai-compatible requires an explicit base URL", () => {
    expect(() => resolveProvider({ provider: "openai-compatible", env: noEnv })).toThrow(
      /requires --llm-base-url/,
    );
    expect(
      resolveProvider({ provider: "openai-compatible", baseUrl: "http://x/v1", env: noEnv })?.name,
    ).toBe("openai-compatible");
  });

  it("reads FLAKETRIAGE_LLM_PROVIDER from the environment", () => {
    const p = resolveProvider({ env: { FLAKETRIAGE_LLM_PROVIDER: "local" } });
    expect(p?.name).toBe("local");
  });

  it("rejects an unknown provider name", () => {
    expect(() => resolveProvider({ provider: "hal9000", env: noEnv })).toThrow(/unknown/i);
  });

  // ── BYOK / self-hosted Anthropic-family providers ────────────────

  it("bedrock: enabled only once a region is configured (flag or env)", () => {
    const unconfigured = resolveProvider({ provider: "bedrock", env: noEnv });
    expect(unconfigured?.name).toBe("bedrock");
    expect(unconfigured?.enabled).toBe(false);

    const viaFlag = resolveProvider({ provider: "bedrock", awsRegion: "us-east-1", env: noEnv });
    expect(viaFlag?.enabled).toBe(true);

    const viaEnv = resolveProvider({
      provider: "bedrock",
      env: { AWS_REGION: "eu-west-1" },
    });
    expect(viaEnv?.enabled).toBe(true);
  });

  it("vertex: enabled only once a project id is configured (flag or env)", () => {
    const unconfigured = resolveProvider({ provider: "vertex", env: noEnv });
    expect(unconfigured?.name).toBe("vertex");
    expect(unconfigured?.enabled).toBe(false);

    const viaFlag = resolveProvider({
      provider: "vertex",
      gcpProjectId: "my-project",
      env: noEnv,
    });
    expect(viaFlag?.enabled).toBe(true);
  });

  it("foundry: enabled only once both resource and API key are configured", () => {
    const unconfigured = resolveProvider({ provider: "foundry", env: noEnv });
    expect(unconfigured?.name).toBe("foundry");
    expect(unconfigured?.enabled).toBe(false);

    const partial = resolveProvider({
      provider: "foundry",
      foundryResource: "my-resource",
      env: noEnv,
    });
    expect(partial?.enabled).toBe(false); // no API key yet

    const full = resolveProvider({
      provider: "foundry",
      foundryResource: "my-resource",
      apiKey: "key",
      env: noEnv,
    });
    expect(full?.enabled).toBe(true);
  });

  it("custom requires an explicit base URL", () => {
    expect(() => resolveProvider({ provider: "custom", env: noEnv })).toThrow(
      /requires --llm-base-url/,
    );
    const p = resolveProvider({
      provider: "custom",
      baseUrl: "https://my-anthropic-proxy.internal/v1",
      env: noEnv,
    });
    expect(p?.name).toBe("custom");
    expect(p?.enabled).toBe(true);
  });

  it("cloud providers default to claude-opus-5 and accept a model override", () => {
    const p = resolveProvider({
      provider: "bedrock",
      awsRegion: "us-east-1",
      model: "claude-sonnet-5",
      env: noEnv,
    });
    expect(p?.model).toBe("claude-sonnet-5");
  });
});
