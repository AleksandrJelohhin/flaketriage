/**
 * classify.ts — the deterministic classifier.
 *
 * One of the four files that ARE the product. Pure: it takes facts
 * already gathered from history + git + normalize + blame and returns a
 * {@link Verdict}. No I/O, no clock, no randomness.
 *
 * Decision tree, first match wins:
 *   1. flake_confirmed — same test_key passed in another attempt of this commit
 *   2. infra_failure   — message matches a known infrastructure signature
 *   3. always_failing  — never passed in recorded history
 *   4. flake_likely    — ≥2 pass/fail flips with the test file unchanged, OR the
 *                        fingerprint seen on ≥3 distinct branches
 *   5. real_regression — passed on the parent commit, fails now, AND blame
 *                        correlation returns ≥1 link (high when exact_line /
 *                        same_hunk, medium otherwise)
 *   6. ambiguous       — hand to the LLM
 *
 * Every verdict carries non-empty `evidence` — plain sentences a human can
 * verify with `flaketriage explain`. Empty evidence is a bug.
 */

import type { BlameLink } from "./blame.js";

export type VerdictKind =
  | "flake_confirmed"
  | "flake_likely"
  | "infra_failure"
  | "always_failing"
  | "real_regression"
  | "ambiguous";

export interface Verdict {
  kind: VerdictKind;
  confidence: "high" | "medium" | "low";
  /** plain sentences a human can check. Never empty. */
  evidence: string[];
  /** deterministic rules, or the escalation model. */
  source: "history" | "model";
  /** stack-frame ↔ changed-file links, when the verdict rests on them. */
  blame?: BlameLink[];
}

export interface InfraSignature {
  /** matched case-insensitively against the normalised message + top frames. */
  pattern: RegExp;
  /** human phrase for the evidence line. */
  label: string;
}

/**
 * Infrastructure failure signatures. Kept as one exported const so
 * it is easy to extend.
 */
export const INFRA_SIGNATURES: readonly InfraSignature[] = [
  { pattern: /\bECONNREFUSED\b|connection refused/i, label: "connection refused" },
  { pattern: /\bECONNRESET\b|socket hang up/i, label: "connection reset / socket hang up" },
  { pattern: /\bETIMEDOUT\b/i, label: "connection timed out" },
  { pattern: /\bEAI_AGAIN\b/i, label: "DNS temporary failure (EAI_AGAIN)" },
  {
    pattern: /net::ERR_(?:CONNECTION_|NETWORK_|ADDRESS_UNREACHABLE|TIMED_OUT|EMPTY_RESPONSE)/i,
    label: "browser network error (net::ERR_…)",
  },
  {
    pattern: /net::ERR_NAME_NOT_RESOLVED|Could not resolve host|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|\bENOTFOUND\b/i,
    label: "DNS resolution failure",
  },
  { pattern: /\bEHOSTUNREACH\b|\bENETUNREACH\b/i, label: "host / network unreachable" },
  {
    pattern: /\b(?:502|503|504)\b[^\n]{0,40}\b(?:from|response|status|gateway|unavailable|timeout)\b|\bBad Gateway\b|\bService Unavailable\b|\bGateway Time-?out\b/i,
    label: "upstream 5xx (gateway / unavailable / timeout)",
  },
  {
    pattern: /\b(?:connection|conn|pool)\s+pool\s+(?:exhausted|timeout|is full)|\bTimedOutError: .*acquiring a connection\b|QueuePool limit .* overflow|too many connections/i,
    label: "connection pool exhausted",
  },
  { pattern: /OOMKilled|\bout of memory\b|java\.lang\.OutOfMemoryError/i, label: "out of memory / OOMKilled" },
  {
    pattern: /\bContainer (?:exited|killed|failed to start)\b|\bpod (?:evicted|OOMKilled)\b/i,
    label: "container exited / killed",
  },
  { pattern: /No space left on device|\bENOSPC\b/i, label: "no space left on device" },
  {
    pattern: /(?:chrome|chromium|firefox|webkit|browser|webdriver|geckodriver|chromedriver)[^\n]{0,60}(?:failed to (?:start|launch)|launch failed|crashed|not reachable)|session not created|unable to (?:connect to|obtain) .{0,40}(?:driver|browser)|Failed to connect to the bus/i,
    label: "browser / WebDriver launch failure",
  },

  {
    pattern: /Runner\.Worker.* exited with code|The runner has received a shutdown signal|The operation was canceled/i,
    label: "CI runner terminated",
  },
  {
    pattern: /Cannot connect to the Docker daemon at unix:\/\/\/var\/run\/docker\.sock|error during connect: .*docker_engine/i,
    label: "Docker daemon unreachable",
  },
  {
    pattern: /\b429 Too Many Requests\b|toomanyrequests: You have reached your pull rate limit/i,
    label: "rate limiting (HTTP 429)",
  },
];

export interface ClassifierInput {
  test: {
    testKey: string;
    suite: string;
    name: string;
    /** `<testcase file>` if known — repo-relative-ish. */
    file: string | null;
  };
  current: {
    /** `failed` or `error` — this function is only called for failures. */
    status: "failed" | "error";
    fingerprint: string;
    /** normalised message + frames joined, for signature matching. */
    normalizedText: string;
    commitSha: string;
    parentSha: string | null;
    attempt: number;
    /** repo-relative paths changed between parent and this commit. */
    changedFiles: string[];
    /** blame links from `correlate(stackFrames, diffHunks)` — may be empty. */
    blameLinks: BlameLink[];
  };
  history: {
    /** the same test_key passed in another attempt of THIS commit. */
    passedSameCommitOtherAttempt: boolean;
    /** the test has at least one recorded pass, ever. */
    everPassed: boolean;
    /** number of prior runs that recorded this test (0 ⇒ no history). */
    priorRuns: number;
    /** outcome recorded for this test on `parentSha`, or null if not recorded. */
    parentOutcome: "pass" | "fail" | null;
    /**
     * Chronological rollup outcomes over the last N runs, each tagged with
     * whether that run's commit changed the test's own file. Includes the
     * current failure as the last element.
     */
    timeline: { outcome: "pass" | "fail"; testFileChanged: boolean }[];
    /** distinct branches this fingerprint has been seen on (incl. current). */
    fingerprintBranches: number;
  };
}

export interface ClassifyOptions {
  /** recent-run window; used only for evidence wording. Default 30. */
  window?: number;
}

const RECENT_WINDOW = 30;

const AMBIGUOUS: Verdict = {
  kind: "ambiguous",
  confidence: "low",
  evidence: ["no deterministic signal (history, fingerprint or blame) — needs a closer look"],
  source: "history",
};

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function unexplainedFlips(
  timeline: { outcome: "pass" | "fail"; testFileChanged: boolean }[],
): { total: number; unexplained: number; considered: number } {
  let total = 0;
  let unexplained = 0;
  for (let i = 1; i < timeline.length; i += 1) {
    if (timeline[i]!.outcome !== timeline[i - 1]!.outcome) {
      total += 1;
      if (!timeline[i]!.testFileChanged) unexplained += 1;
    }
  }
  return { total, unexplained, considered: timeline.length };
}

function blameSentence(link: BlameLink): string {
  const at = `frame ${link.frame.depth} (${link.frame.file}${
    link.frame.line !== null ? `:${link.frame.line}` : ""
  })`;
  switch (link.proximity) {
    case "exact_line":
      return `${at} is on a line this PR changed in ${link.changedFile}`;
    case "same_hunk":
      return `${at} is within 5 lines of a hunk this PR changed in ${link.changedFile}`;
    case "same_file":
      return `${at} is in ${link.changedFile}, which this PR changed`;
    case "imported_by":
      return `${at} is in a file that imports ${link.changedFile}, which this PR changed`;
  }
}

export function classify(input: ClassifierInput, opts: ClassifyOptions = {}): Verdict {
  const { current, history } = input;
  const window = opts.window ?? RECENT_WINDOW;

  // 1 ─ flake_confirmed: proof, not inference
  if (history.passedSameCommitOtherAttempt) {
    return {
      kind: "flake_confirmed",
      confidence: "high",
      source: "history",
      evidence: [
        `passed in another attempt of the same commit ${shortSha(current.commitSha)} ` +
          `(this is attempt ${current.attempt}) — the code did not change between attempts`,
      ],
    };
  }

  // 2 ─ infra_failure: known infrastructure signature
  const infra = INFRA_SIGNATURES.find((s) => s.pattern.test(current.normalizedText));
  if (infra) {
    return {
      kind: "infra_failure",
      confidence: "high",
      source: "history",
      evidence: [
        `failure looks like an infrastructure problem (${infra.label}), not a code defect`,
        "environmental — retrying or fixing the environment resolves it, your change did not cause it",
      ],
    };
  }

  // 3 ─ always_failing: never passed in recorded history
  if (history.priorRuns >= 1 && !history.everPassed) {
    return {
      kind: "always_failing",
      confidence: "high",
      source: "history",
      evidence: [
        `this test has never passed in ${history.priorRuns} recorded run(s) — ` +
          "it is already broken or quarantined; not something this PR broke",
      ],
    };
  }

  // 4 ─ flake_likely
  const flips = unexplainedFlips(history.timeline);
  const evidence4: string[] = [];
  if (flips.unexplained >= 2) {
    const rate = flips.considered > 1 ? flips.total / (flips.considered - 1) : 0;
    evidence4.push(
      `flipped pass↔fail ${flips.total} time(s) over the last ${Math.min(
        flips.considered,
        window,
      )} run(s) (flip rate ${Math.round(rate * 100)}%), ` +
        `${flips.unexplained} of those with no change to the test file`,
    );
  }
  if (history.fingerprintBranches >= 3) {
    evidence4.push(
      `this exact failure fingerprint (${current.fingerprint}) has appeared on ` +
        `${history.fingerprintBranches} distinct branches — a shared flake, not caused by this branch`,
    );
  }
  if (evidence4.length > 0) {
    return { kind: "flake_likely", confidence: "medium", source: "history", evidence: evidence4 };
  }

  // 5 ─ real_regression: green on the parent, red now, AND blame links this diff
  if (history.parentOutcome === "pass" && current.blameLinks.length > 0) {
    const links = current.blameLinks.slice(0, 5);
    const strong = links.find(
      (l) => l.proximity === "exact_line" || l.proximity === "same_hunk",
    );
    const top = strong ?? links[0]!;
    return {
      kind: "real_regression",
      confidence: strong ? "high" : "medium",
      source: "history",
      blame: links,
      evidence: [
        `passed on the parent commit ${
          current.parentSha ? shortSha(current.parentSha) : "(parent)"
        } and fails here`,
        blameSentence(top),
      ],
    };
  }

  // 6 ─ not enough deterministic signal
  return AMBIGUOUS;
}
