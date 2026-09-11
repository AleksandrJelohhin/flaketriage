import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FlakeTriageError } from "../src/core/errors.js";
import { loadConfig } from "../src/config.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ft-config-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("loadConfig", () => {
  it("returns an empty config, not an error, when no file exists", () => {
    const { config, path } = loadConfig(root);
    expect(config).toEqual({});
    expect(path).toBeNull();
  });

  it("loads a valid .flaketriage.yml", () => {
    writeFileSync(
      join(root, ".flaketriage.yml"),
      [
        "llm:",
        "  provider: gemini",
        "  model: gemini-2.5-flash",
        "  base_url: https://example.test/v1",
        "redact:",
        "  patterns:",
        '    - "internal-[a-z]+-token"',
        "",
      ].join("\n"),
    );

    const { config, path } = loadConfig(root);
    expect(path).not.toBeNull();
    expect(config.llm).toEqual({
      provider: "gemini",
      model: "gemini-2.5-flash",
      base_url: "https://example.test/v1",
    });
    expect(config.redact?.patterns).toEqual(["internal-[a-z]+-token"]);
  });

  it("accepts a partial config (llm only, redact only, or neither)", () => {
    writeFileSync(join(root, ".flaketriage.yml"), "llm:\n  provider: anthropic\n");
    expect(loadConfig(root).config).toEqual({ llm: { provider: "anthropic" } });
  });

  it("also finds .flaketriage.yaml", () => {
    writeFileSync(join(root, ".flaketriage.yaml"), "llm:\n  model: claude-sonnet-5\n");
    expect(loadConfig(root).config.llm?.model).toBe("claude-sonnet-5");
  });

  it("an empty file is a valid (empty) config", () => {
    writeFileSync(join(root, ".flaketriage.yml"), "");
    expect(loadConfig(root).config).toEqual({});
  });

  it("throws CONFIG_INVALID on malformed YAML", () => {
    writeFileSync(join(root, ".flaketriage.yml"), "llm:\n  provider: [unterminated\n");
    expect(() => loadConfig(root)).toThrow(FlakeTriageError);
    try {
      loadConfig(root);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FlakeTriageError);
      expect((e as FlakeTriageError).code).toBe("CONFIG_INVALID");
    }
  });

  it("throws CONFIG_INVALID on an unknown field (fail loud, not silently ignore a typo)", () => {
    writeFileSync(join(root, ".flaketriage.yml"), "llm:\n  provider: anthropic\n  modle: typo\n");
    expect(() => loadConfig(root)).toThrow(/CONFIG_INVALID|modle/);
  });

  it("throws CONFIG_INVALID when a field has the wrong type", () => {
    writeFileSync(join(root, ".flaketriage.yml"), "llm:\n  provider: 42\n");
    expect(() => loadConfig(root)).toThrow(FlakeTriageError);
  });
});
