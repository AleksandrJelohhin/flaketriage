import { describe, expect, it } from "vitest";

import type { Verdict } from "../src/core/classify.js";
import type { TriagedResult, TriagedRun } from "../src/pipeline.js";
import { renderJsonReport } from "../src/report/json.js";
import { renderMarkdown, STICKY_MARKER } from "../src/report/markdown.js";
import { renderText } from "../src/report/text.js";
import { gitContext, triagedResult, verdict } from "./helpers/factories.js";

function run(triagedItems: TriagedResult[], over: Partial<TriagedRun> = {}): TriagedRun {
  return {
    git: gitContext({
      commitSha: "abcdef1234567",
      parentSha: "0987654321fed",
      branch: "feature/x",
      changedFiles: ["src/pricing/discount.py"],
    }),
    attempt: 1,
    total: 10 + triagedItems.length,
    passed: 10,
    skipped: 0,
    triaged: triagedItems,
    ambiguousCount: triagedItems.filter((t) => t.verdict.kind === "ambiguous").length,
    ...over,
  };
}

const REG: Verdict = verdict("real_regression", {
  evidence: ["passed on the parent commit 0987654 and fails here", "frame 1 is on a line this PR changed in src/pricing/discount.py"],
});
const FLAKE: Verdict = verdict("flake_confirmed", {
  evidence: ["passed in another attempt of the same commit abcdef1"],
});
const INFRA: Verdict = verdict("infra_failure", {
  evidence: ["failure looks like an infrastructure problem (connection refused), not a code defect"],
});
const AMBIG: Verdict = verdict("ambiguous");

describe("renderMarkdown", () => {
  it("carries the sticky marker as the first line", () => {
    expect(renderMarkdown(run([])).split("\n")[0]).toBe(STICKY_MARKER);
  });

  it("groups by action — Needs you before Safe to ignore", () => {
    const md = renderMarkdown(run([triagedResult("flaky", FLAKE), triagedResult("reg", REG), triagedResult("infra", INFRA)]));
    const iNeeds = md.indexOf("Needs you");
    const iSafe = md.indexOf("Safe to ignore");
    expect(iNeeds).toBeGreaterThan(0);
    expect(iNeeds).toBeLessThan(iSafe);
    expect(md).toMatch(/Safe to ignore — 1 flake, 1 infra failure/);
    expect(md).toMatch(/Needs you — 1 likely broken by this PR/);
  });

  it("always shows the cost line, the history/model split, and an explain hint", () => {
    const md = renderMarkdown(run([triagedResult("reg", REG)]));
    expect(md).toMatch(/<sub>FlakeTriage · 1 from history · \$0\.00 · commit abcdef1/);
    expect(md).toMatch(/flaketriage explain "reg"/);
  });

  it("adds a 'Start at' hint from the blame link for regressions", () => {
    const item = triagedResult(
      "reg",
      verdict("real_regression", {
        evidence: ["passed on the parent commit and fails here", "frame 1 is on a line this PR changed"],
        blame: [
          {
            frame: { file: "src/pricing/discount.py", line: 2, symbol: "apply", raw: "at apply", depth: 1 },
            changedFile: "src/pricing/discount.py",
            proximity: "exact_line",
            confidence: 0.95,
          },
        ],
      }),
    );
    const md = renderMarkdown(run([item]));
    expect(md).toMatch(/→ Start at `src\/pricing\/discount\.py:2`/);
  });

  it("stays compact (≤ 40 lines) even with many failures", () => {
    const many = Array.from({ length: 25 }, (_v, i) => triagedResult(`t${i}`, FLAKE));
    const md = renderMarkdown(run(many));
    expect(md.split("\n").length).toBeLessThanOrEqual(40);
    expect(md).toMatch(/…and \d+ more/);
  });

  it("🟢 when no failures, 🔴 when a regression, 🟠 when only unclear/broken", () => {
    expect(renderMarkdown(run([]))).toMatch(/### 🟢 FlakeTriage — no failures/);
    expect(renderMarkdown(run([triagedResult("r", REG)]))).toMatch(/### 🔴/);
    expect(renderMarkdown(run([triagedResult("a", AMBIG)]))).toMatch(/### 🟠/);
    expect(renderMarkdown(run([triagedResult("f", FLAKE)]))).toMatch(/### 🟢/);
  });
});

describe("renderText", () => {
  it("renders a plain summary with per-verdict evidence", () => {
    const txt = renderText(run([triagedResult("reg", REG), triagedResult("flaky", FLAKE)]));
    expect(txt).toMatch(/FlakeTriage — 10 passed, 2 failed\/error, 0 skipped/);
    expect(txt).toMatch(/Needs you/);
    expect(txt).toMatch(/likely broken by this PR/);
    expect(txt).toMatch(/passed on the parent commit/);
    expect(txt).toMatch(/from history · \$0\.00/);
  });

  it("no ANSI escape codes when color is off", () => {
    const txt = renderText(run([triagedResult("r", REG)]), false);
    expect(txt).not.toContain(String.fromCharCode(27));
  });
});
