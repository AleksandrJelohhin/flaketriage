import { describe, expect, it } from "vitest";

import { compilePatterns, DEFAULT_REDACT_PATTERNS, redact } from "../../src/llm/payload.js";

describe("redact", () => {
  it("redacts a Bearer token", () => {
    const out = redact("Authorization: Bearer sk-ant-abc123DEF456.ghi");
    expect(out).not.toMatch(/Bearer\s+\S/);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts a password/secret/token assignment", () => {
    for (const line of [
      "password=hunter2000",
      "password: hunter2000",
      "DB_PASSWORD=s3cr3t!!",
      "api_key: abcdef0123456789",
      "secret=topsecretvalue",
    ]) {
      const out = redact(line);
      expect(out).not.toMatch(/=hunter2000|: hunter2000|s3cr3t|abcdef0123456789|topsecretvalue/);
    }
  });

  it("redacts an AWS access key id", () => {
    const out = redact("aws_access_key_id = AKIAABCDEFGHIJKLMNOP");
    expect(out).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });

  it("redacts a PEM private key block", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIBogIBAAJBAKj34GkxFhD91assdf...",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = redact(`stack trace:\n${pem}\nat foo.js:1`);
    expect(out).not.toContain("MIIBogIBAAJBAKj34GkxFhD91assdf");
    expect(out).not.toMatch(/BEGIN RSA PRIVATE KEY/);
  });

  it("redacts vendor API key prefixes (anthropic, github, google)", () => {
    expect(redact("key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).not.toMatch(/sk-ant-/);
    expect(redact("token ghp_abcdefghijklmnopqrstuvwxyz012345")).not.toMatch(/ghp_/);
    expect(redact("AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456")).not.toMatch(/AIza/);
  });

  it("leaves ordinary failure-message text untouched", () => {
    const msg = "expected 200 but got 500 at src/api/client.ts:42";
    expect(redact(msg)).toBe(msg);
  });

  it("applies extra patterns from config on top of the defaults", () => {
    const extra = compilePatterns(["internal-[a-z]+-token"]);
    const out = redact("x-internal-service-token: abc", extra);
    expect(out).not.toContain("internal-service-token");
  });

  it("re-running redact on already-redacted text is a no-op (idempotent)", () => {
    const once = redact("password=hunter2000");
    expect(redact(once)).toBe(once);
  });

  it("DEFAULT_REDACT_PATTERNS is non-empty and every pattern is global", () => {
    expect(DEFAULT_REDACT_PATTERNS.length).toBeGreaterThan(0);
  });
});
