import { describe, expect, it } from "vitest";

import type { Verdict } from "../src/core/classify.js";
import type { TriagedResult, TriagedRun } from "../src/pipeline.js";
import { renderSummary } from "../src/report/summary.js";
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
  evidence: [
    "passed on the parent commit 0987654 and fails here",
    "frame 1 is on a line this PR changed in src/pricing/discount.py",
  ],
  blame: [
    {
      frame: { file: "src/pricing/discount.py", line: 2, symbol: "apply", raw: "at apply", depth: 1 },
      changedFile: "src/pricing/discount.py",
      proximity: "exact_line",
      confidence: 0.95,
    },
  ],
});
const FLAKE: Verdict = verdict("flake_confirmed", {
  evidence: ["passed in another attempt of the same commit abcdef1"],
});
const INFRA: Verdict = verdict("infra_failure", {
  evidence: ["failure looks like an infrastructure problem (connection refused), not a code defect"],
});

describe("renderSummary", () => {
  it("shows a no-failures message when nothing failed", () => {
    const md = renderSummary(run([]));
    expect(md).toMatch(/## 🟢 FlakeTriage/);
    expect(md).toMatch(/No failures on this run\./);
  });

  it("includes the run info line and stats table", () => {
    const md = renderSummary(run([triagedResult("reg", REG)]));
    expect(md).toMatch(/commit `abcdef1`/);
    expect(md).toMatch(/branch `feature\/x`/);
    expect(md).toMatch(/parent `0987654`/);
    expect(md).toMatch(/attempt 1/);
    expect(md).toMatch(/\| Total \| Passed \| Failed \| Skipped \| Needs you \| Cost \|/);
  });

  it("groups every failure by action bucket, with no truncation", () => {
    const many = Array.from({ length: 25 }, (_v, i) => triagedResult(`t${i}`, FLAKE));
    const md = renderSummary(run(many));
    for (let i = 0; i < 25; i += 1) {
      expect(md).toContain(`t${i}`);
    }
    expect(md).not.toMatch(/…and \d+ more/);
  });

  it("renders a blame table for a regression with blame links", () => {
    const md = renderSummary(run([triagedResult("reg", REG)]));
    expect(md).toMatch(/\| Confidence \| Proximity \| Frame \| Changed file \|/);
    expect(md).toMatch(/exact_line/);
    expect(md).toMatch(/`src\/pricing\/discount\.py:2`/);
  });

  it("includes the raw failure message and stack in a code fence", () => {
    const md = renderSummary(run([triagedResult("reg", REG)]));
    expect(md).toMatch(/```\nreg failed\n```/);
    expect(md).toMatch(/at f \(src\/x\.py:3\)/);
  });

  it("keeps needs-you items expanded and others collapsed by default", () => {
    const md = renderSummary(run([triagedResult("reg", REG), triagedResult("infra", INFRA)]));
    expect(md).toMatch(/<details open>\n<summary><code>acme\.Suite › reg<\/code>/);
    expect(md).toMatch(/<details>\n<summary><code>acme\.Suite › infra<\/code>/);
  });

  it("always shows the cost / history-vs-model accounting footer", () => {
    const md = renderSummary(run([triagedResult("reg", REG)]));
    expect(md).toMatch(/<sub>FlakeTriage · 1 from history · \$0\.00<\/sub>/);
  });

  it("carries an explain hint per item", () => {
    const md = renderSummary(run([triagedResult("reg", REG)]));
    expect(md).toMatch(/flaketriage explain "reg"/);
  });
});
