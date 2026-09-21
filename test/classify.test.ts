import { describe, expect, it } from "vitest";

import type { BlameLink, Proximity } from "../src/core/blame.js";
import { classify, INFRA_SIGNATURES } from "../src/core/classify.js";
import type { ClassifierInput, Verdict } from "../src/core/classify.js";

/**
 * The deterministic classifier. Every rule is covered here with a
 * hand-built history. classify() is pure, so the tests just assemble facts.
 */

function link(
  proximity: Proximity,
  over: Partial<BlameLink["frame"]> = {},
): BlameLink {
  const confidence = { exact_line: 0.95, same_hunk: 0.8, same_file: 0.5, imported_by: 0.3 }[
    proximity
  ];
  return {
    frame: { file: "src/pricing/discount.ts", line: 42, symbol: "apply", raw: "at apply", depth: 1, ...over },
    changedFile: "src/pricing/discount.ts",
    proximity,
    confidence,
  };
}

function input(over: DeepPartial<ClassifierInput> = {}): ClassifierInput {
  const base: ClassifierInput = {
    test: { testKey: "k", suite: "acme.FooTest", name: "does a thing", file: "src/foo.py" },
    current: {
      status: "failed",
      fingerprint: "abc123def456",
      normalizedText: "AssertionError: expected 1 but got 2",
      commitSha: "c0ffee1234567",
      parentSha: "beef7654321",
      attempt: 1,
      changedFiles: [],
      blameLinks: [],
    },
    history: {
      passedSameCommitOtherAttempt: false,
      everPassed: true,
      priorRuns: 5,
      parentOutcome: null,
      timeline: [{ outcome: "fail", testFileChanged: false }],
      fingerprintBranches: 1,
    },
  };
  return merge(base, over);
}

describe("Verdict shape", () => {
  it("is flat: every verdict has kind/confidence/evidence/source", () => {
    for (const v of [
      classify(input()),
      classify(input({ history: { passedSameCommitOtherAttempt: true } })),
    ]) {
      expect(v).toMatchObject({
        kind: expect.any(String),
        confidence: expect.stringMatching(/high|medium|low/),
        source: "history",
      });
      expect(v.evidence.length).toBeGreaterThan(0);
    }
  });
});

describe("rule 1 — flake_confirmed", () => {
  it("fires when the test passed in another attempt of the same commit", () => {
    const v = classify(input({ history: { passedSameCommitOtherAttempt: true } }));
    expect(v).toMatchObject({ kind: "flake_confirmed", confidence: "high" });
    expect(v.evidence[0]).toMatch(/another attempt of the same commit/);
  });

  it("beats every other rule", () => {
    const v = classify(
      input({
        current: { normalizedText: "ECONNREFUSED", blameLinks: [link("exact_line")] },
        history: {
          passedSameCommitOtherAttempt: true,
          everPassed: false,
          parentOutcome: "pass",
        },
      }),
    );
    expect(v.kind).toBe("flake_confirmed");
  });
});

describe("rule 2 — infra_failure", () => {
  const cases: [string, string][] = [
    ["ECONNREFUSED", "Error: connect ECONNREFUSED 127.0.0.1:5432"],
    ["ETIMEDOUT", "request failed: ETIMEDOUT"],
    ["EAI_AGAIN", "getaddrinfo EAI_AGAIN registry.npmjs.org"],
    ["socket hang up", "Error: socket hang up"],
    ["net::ERR_", "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000"],
    ["DNS", "getaddrinfo ENOTFOUND api.internal"],
    ["5xx", "received 503 Service Unavailable from upstream"],
    ["pool exhausted", "TimedOutError: Timed out acquiring a connection from the pool"],
    ["OOM", "Container was OOMKilled"],
    ["disk", "No space left on device"],
    ["browser", "session not created: chrome failed to start"],
    ["Docker daemon", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"],
    ["rootless Docker", "Cannot connect to the Docker daemon at unix:///run/user/1001/docker.sock. Is the docker daemon running?"],
    ["DOCKER_HOST over tcp", "Cannot connect to the Docker daemon at tcp://localhost:<PORT>. Is the docker daemon running?"],
    ["Docker on Windows", 'error during connect: Get "http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.24/containers/json": open //./pipe/docker_engine'],
    ["registry pull rate limit", "Error response from daemon: toomanyrequests: You have reached your pull rate limit."],
  ];
  it.each(cases)("recognises %s", (_label, text) => {
    const v = classify(input({ current: { normalizedText: text } }));
    expect(v).toMatchObject({ kind: "infra_failure", confidence: "high" });
  });

  const notInfra: [string, string][] = [
    ["unrelated Docker text", "Docker image built successfully and container started"],
    // the app under test rate-limiting a request is a test result, not infrastructure
    ["an app's own 429", "AssertionError: expected 200 but got 429 Too Many Requests"],
  ];
  it.each(notInfra)("does NOT treat %s as infra", (_label, text) => {
    const v = classify(input({ current: { normalizedText: text } }));
    expect(v.kind).not.toBe("infra_failure");
  });

  it("beats always_failing and real_regression", () => {
    const v = classify(
      input({
        current: { normalizedText: "socket hang up", blameLinks: [link("exact_line")] },
        history: { everPassed: false, parentOutcome: "pass" },
      }),
    );
    expect(v.kind).toBe("infra_failure");
  });

  it("every signature has a label and a working pattern", () => {
    for (const sig of INFRA_SIGNATURES) {
      expect(sig.label.length).toBeGreaterThan(3);
      expect(sig.pattern).toBeInstanceOf(RegExp);
    }
  });
});

describe("rule 3 — always_failing", () => {
  it("fires when the test has recorded runs but has never passed", () => {
    const v = classify(input({ history: { everPassed: false, priorRuns: 8 } }));
    expect(v.kind).toBe("always_failing");
    expect(v.evidence.join(" ")).toMatch(/never passed in 8 recorded run/);
  });

  it("does NOT fire on the very first sighting of a failing test", () => {
    const v = classify(
      input({ history: { everPassed: false, priorRuns: 0, parentOutcome: null } }),
    );
    expect(v.kind).not.toBe("always_failing");
  });
});

describe("rule 4 — flake_likely", () => {
  it("fires on ≥2 pass↔fail flips with the test file unchanged", () => {
    const timeline = [
      { outcome: "pass" as const, testFileChanged: false },
      { outcome: "fail" as const, testFileChanged: false },
      { outcome: "pass" as const, testFileChanged: false },
      { outcome: "fail" as const, testFileChanged: false },
    ];
    const v = classify(input({ history: { timeline } }));
    expect(v).toMatchObject({ kind: "flake_likely", confidence: "medium" });
    expect(v.evidence.join(" ")).toMatch(/flip rate/);
  });

  it("does NOT fire when the flips line up with test-file changes", () => {
    const timeline = [
      { outcome: "pass" as const, testFileChanged: false },
      { outcome: "fail" as const, testFileChanged: true },
      { outcome: "pass" as const, testFileChanged: true },
      { outcome: "fail" as const, testFileChanged: true },
    ];
    const v = classify(input({ history: { timeline, parentOutcome: null } }));
    expect(v.kind).not.toBe("flake_likely");
  });

  it("fires when the fingerprint has been seen on ≥3 branches", () => {
    const v = classify(input({ history: { fingerprintBranches: 4 } }));
    expect(v.kind).toBe("flake_likely");
    expect(v.evidence.join(" ")).toMatch(/distinct branches/);
  });

  it("comes before real_regression", () => {
    const timeline = [
      { outcome: "pass" as const, testFileChanged: false },
      { outcome: "fail" as const, testFileChanged: false },
      { outcome: "pass" as const, testFileChanged: false },
      { outcome: "fail" as const, testFileChanged: false },
    ];
    const v = classify(
      input({
        current: { blameLinks: [link("exact_line")] },
        history: { timeline, parentOutcome: "pass" },
      }),
    );
    expect(v.kind).toBe("flake_likely");
  });
});

describe("rule 5 — real_regression (blame-driven)", () => {
  it("high confidence when a blame link is exact_line", () => {
    const v = classify(
      input({
        current: { blameLinks: [link("exact_line")] },
        history: { parentOutcome: "pass" },
      }),
    );
    expect(v).toMatchObject({ kind: "real_regression", confidence: "high" });
    expect(v.blame).toHaveLength(1);
    expect(v.evidence.join(" ")).toMatch(/on a line this PR changed/);
  });

  it("high confidence when a blame link is same_hunk", () => {
    const v = classify(
      input({ current: { blameLinks: [link("same_hunk")] }, history: { parentOutcome: "pass" } }),
    );
    expect(v).toMatchObject({ kind: "real_regression", confidence: "high" });
  });

  it("medium confidence for a same_file / imported_by link", () => {
    const v = classify(
      input({ current: { blameLinks: [link("same_file")] }, history: { parentOutcome: "pass" } }),
    );
    expect(v).toMatchObject({ kind: "real_regression", confidence: "medium" });

    const v2 = classify(
      input({ current: { blameLinks: [link("imported_by")] }, history: { parentOutcome: "pass" } }),
    );
    expect(v2).toMatchObject({ kind: "real_regression", confidence: "medium" });
  });

  it("does NOT fire on a bare pass→fail transition with NO blame link", () => {
    const v = classify(
      input({ current: { blameLinks: [] }, history: { parentOutcome: "pass" } }),
    );
    expect(v.kind).toBe("ambiguous");
  });

  it("does NOT fire when the parent outcome is unknown", () => {
    expect(
      classify(input({ current: { blameLinks: [link("exact_line")] }, history: { parentOutcome: null } })).kind,
    ).toBe("ambiguous");
  });

  it("does NOT fire when the test also failed on the parent", () => {
    expect(
      classify(input({ current: { blameLinks: [link("exact_line")] }, history: { parentOutcome: "fail" } })).kind,
    ).toBe("ambiguous");
  });
});

describe("rule 6 — ambiguous", () => {
  it("is the fallthrough, and it carries evidence + low confidence + source", () => {
    const v = classify(input());
    expect(v).toMatchObject({ kind: "ambiguous", confidence: "low", source: "history" });
    expect(v.evidence[0]).toMatch(/no deterministic signal/);
  });
});

describe("evidence contract", () => {
  it("every verdict carries non-empty, plain-sentence evidence", () => {
    const verdicts: Verdict[] = [
      classify(input({ history: { passedSameCommitOtherAttempt: true } })),
      classify(input({ current: { normalizedText: "ECONNREFUSED" } })),
      classify(input({ history: { everPassed: false, priorRuns: 3 } })),
      classify(input({ history: { fingerprintBranches: 5 } })),
      classify(input({ current: { blameLinks: [link("exact_line")] }, history: { parentOutcome: "pass" } })),
      classify(input()),
    ];
    for (const v of verdicts) {
      expect(v.evidence.length).toBeGreaterThan(0);
      for (const e of v.evidence) expect(e.trim().length).toBeGreaterThan(10);
    }
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
function merge<T>(base: T, over: DeepPartial<T>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = merge((base as Record<string, unknown>)[k], v as never);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
