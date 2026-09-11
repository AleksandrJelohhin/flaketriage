import { describe, expect, it } from "vitest";

import {
  createBedrockProvider,
  createCustomProvider,
  createFoundryProvider,
  createVertexProvider,
} from "../../src/llm/providers/cloud.js";

/**
 * These call the *factory* functions directly (not `resolveProvider`), so we
 * can assert the env-injection / precedence rules in isolation. None of these
 * construct a real client when unconfigured (spec: never throw or start a
 * network/credential probe at resolution time) — see cloud.ts's comments.
 */

const noEnv: NodeJS.ProcessEnv = {};

describe("cloud.ts — BYOK / self-hosted Anthropic-family providers", () => {
  describe("createBedrockProvider", () => {
    it("disabled with no region anywhere — construction never throws", () => {
      const p = createBedrockProvider({ env: noEnv });
      expect(p.name).toBe("bedrock");
      expect(p.enabled).toBe(false);
      expect(p.model).toBe("claude-opus-5");
    });

    it("enabled once awsRegion is passed explicitly", () => {
      const p = createBedrockProvider({ awsRegion: "us-east-1", env: noEnv });
      expect(p.enabled).toBe(true);
    });

    it("falls back to AWS_REGION then AWS_DEFAULT_REGION from env", () => {
      expect(createBedrockProvider({ env: { AWS_REGION: "us-east-1" } }).enabled).toBe(true);
      expect(
        createBedrockProvider({ env: { AWS_DEFAULT_REGION: "us-west-2" } }).enabled,
      ).toBe(true);
    });

    it("an explicit awsRegion wins over env", () => {
      const p = createBedrockProvider({
        awsRegion: "eu-central-1",
        env: { AWS_REGION: "us-east-1" },
      });
      expect(p.enabled).toBe(true);
    });

    it("a disabled provider rejects if triage/countTokens are called anyway", async () => {
      const p = createBedrockProvider({ env: noEnv });
      await expect(p.countTokens("s", "u")).rejects.toThrow(/not configured/);
      await expect(p.triage("s", "u")).rejects.toThrow(/not configured/);
    });
  });

  describe("createVertexProvider", () => {
    it("disabled with no project id anywhere — construction never throws", () => {
      const p = createVertexProvider({ env: noEnv });
      expect(p.name).toBe("vertex");
      expect(p.enabled).toBe(false);
    });

    it("enabled once a project id is configured", () => {
      const p = createVertexProvider({ projectId: "my-project", env: noEnv });
      expect(p.enabled).toBe(true);
    });

    it("falls back to ANTHROPIC_VERTEX_PROJECT_ID from env", () => {
      const p = createVertexProvider({ env: { ANTHROPIC_VERTEX_PROJECT_ID: "gcp-proj" } });
      expect(p.enabled).toBe(true);
    });
  });

  describe("createFoundryProvider", () => {
    it("disabled unless BOTH resource and API key are configured", () => {
      expect(createFoundryProvider({ env: noEnv }).enabled).toBe(false);
      expect(createFoundryProvider({ resource: "r", env: noEnv }).enabled).toBe(false);
      expect(createFoundryProvider({ apiKey: "k", env: noEnv }).enabled).toBe(false);
      expect(createFoundryProvider({ resource: "r", apiKey: "k", env: noEnv }).enabled).toBe(
        true,
      );
    });

    it("falls back to ANTHROPIC_FOUNDRY_RESOURCE / ANTHROPIC_FOUNDRY_API_KEY", () => {
      const p = createFoundryProvider({
        env: {
          ANTHROPIC_FOUNDRY_RESOURCE: "my-resource",
          ANTHROPIC_FOUNDRY_API_KEY: "key",
        },
      });
      expect(p.enabled).toBe(true);
    });
  });

  describe("createCustomProvider", () => {
    it("disabled with an empty base URL", () => {
      expect(createCustomProvider({ baseUrl: "" }).enabled).toBe(false);
    });

    it("enabled with a base URL, no API key required (self-hosted)", () => {
      const p = createCustomProvider({ baseUrl: "https://proxy.internal/v1" });
      expect(p.name).toBe("custom");
      expect(p.enabled).toBe(true);
    });

    it("accepts a model override, otherwise defaults to claude-opus-5", () => {
      expect(createCustomProvider({ baseUrl: "https://x/v1" }).model).toBe("claude-opus-5");
      expect(
        createCustomProvider({ baseUrl: "https://x/v1", model: "claude-sonnet-5" }).model,
      ).toBe("claude-sonnet-5");
    });
  });
});
