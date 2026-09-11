/**
 * explain.ts — assemble the full evidence for one test's verdict.
 *
 * `flaketriage explain <test>` is the answer to "I don't believe your tool"
 *: it re-derives the deterministic verdict for the test's most
 * recent recorded failure and lays out every input — the run timeline, the
 * fingerprint and where else it has been seen, and the blame links — so a
 * skeptical engineer can check each claim by hand.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { correlate, parseImports, parseStackFrames } from "./core/blame.js";
import type { BlameLink } from "./core/blame.js";
import { classify } from "./core/classify.js";
import type { ClassifierInput, Verdict } from "./core/classify.js";
import { FlakeTriageError } from "./core/errors.js";
import { fingerprintFailure } from "./core/fingerprint.js";
import { History } from "./core/history.js";
import type { LatestFailure } from "./core/history.js";
import { normalizeFailure } from "./core/normalize.js";
import { readDiffHunks, readGitContext } from "./ingest/git.js";

export interface ExplainReport {
  testKey: string;
  suite: string;
  testName: string;
  /** other tests that also matched the query, if the match was ambiguous. */
  otherMatches: { testKey: string; suite: string; testName: string }[];
  verdict: Verdict;
  latest: LatestFailure;
  timeline: {
    startedAt: number;
    commitSha: string;
    branch: string | null;
    attempt: number;
    status: string;
    fingerprint: string | null;
  }[];
  fingerprint: {
    value: string;
    occurrences: number;
    distinctBranches: number;
    distinctCommits: number;
    distinctTestKeys: number;
    firstSeen: number;
    lastSeen: number;
  } | null;
  blame: BlameLink[];
  /** true when blame ran against a live diff (vs. the stored file list only). */
  blameFromLiveDiff: boolean;
  history: {
    priorRuns: number;
    everPassed: boolean;
    parentOutcome: "pass" | "fail" | null;
    passedSameCommitOtherAttempt: boolean;
  };
}

export interface ExplainOptions {
  repoPath: string;
  db: string;
  window?: number;
}

export async function explainTest(
  query: string,
  opts: ExplainOptions,
): Promise<ExplainReport> {
  const window = opts.window ?? 30;
  const history = History.open(resolve(opts.db));
  try {
    const matches = history.findTests(query);
    if (matches.length === 0) {
      throw new FlakeTriageError("NO_REPORTS", `no test in history matches "${query}"`);
    }
    const target = matches[0]!;
    const latest = history.latestFailure(target.testKey);
    if (!latest) {
      throw new FlakeTriageError(
        "NO_REPORTS",
        `"${target.suite} › ${target.testName}" has runs recorded but no failure to explain`,
      );
    }

    const timeline = history.timelineByTestKey(target.testKey).map((t) => ({
      startedAt: t.startedAt,
      commitSha: t.commitSha,
      branch: t.branch,
      attempt: t.attempt,
      status: t.status,
      fingerprint: t.fingerprint,
    }));

    const failure = { message: latest.message, stack: latest.stack, type: null };
    const fpValue =
      latest.fingerprint ??
      (latest.message || latest.stack ? fingerprintFailure(failure) : "");
    const spread = fpValue ? history.fingerprintSpread(fpValue) : null;

    // blame — prefer a live diff for the recorded commit, else the stored file list
    let diffHunks = latest.parentSha
      ? await readDiffHunks(opts.repoPath, latest.commitSha, latest.parentSha).catch(() => [])
      : [];
    let blameFromLiveDiff = diffHunks.length > 0;
    if (diffHunks.length === 0 && latest.changedFiles.length > 0) {
      // file-level only: an out-of-range hunk so `correlate` can never infer
      // exact_line / same_hunk, just same_file / imported_by.
      diffHunks = latest.changedFiles.map((file) => ({
        file,
        newStart: Number.MAX_SAFE_INTEGER,
        newLines: 0,
        changedLines: [],
      }));
    }

    const frames = latest.stack ? parseStackFrames(latest.stack) : [];
    const repoRoot = await repoRootOf(opts.repoPath);
    const importsOf = makeImportsResolver(repoRoot);
    const blame =
      frames.length > 0 && diffHunks.length > 0
        ? correlate(frames, diffHunks, { importsOf })
        : [];

    const norm = normalizeFailure(failure, { repoRoot });
    const parentOutcome = latest.parentSha
      ? history.outcomeOnCommit(latest.parentSha, target.testKey)
      : null;
    const priorTimeline = history.timelineByTestKey(target.testKey).slice(0, -1);

    const input: ClassifierInput = {
      test: { testKey: target.testKey, suite: latest.suite, name: latest.testName, file: null },
      current: {
        status: latest.status === "error" ? "error" : "failed",
        fingerprint: fpValue,
        normalizedText: [norm.message, ...norm.frames].join("\n"),
        commitSha: latest.commitSha,
        parentSha: latest.parentSha,
        attempt: latest.attempt,
        changedFiles: latest.changedFiles,
        blameLinks: blame,
      },
      history: {
        passedSameCommitOtherAttempt: history.passedInAnotherAttempt(
          latest.commitSha,
          target.testKey,
          latest.attempt,
        ),
        everPassed: history.everPassed(target.testKey),
        priorRuns: priorTimeline.length,
        parentOutcome,
        timeline: [
          ...priorTimeline.slice(-window + 1).map((t) => ({
            outcome: t.status === "passed" ? ("pass" as const) : ("fail" as const),
            testFileChanged: false,
          })),
          { outcome: "fail" as const, testFileChanged: false },
        ],
        fingerprintBranches: Math.max(spread?.distinctBranches ?? 0, latest.branch ? 1 : 0),
      },
    };
    const verdict = classify(input, { window });

    return {
      testKey: target.testKey,
      suite: latest.suite,
      testName: latest.testName,
      otherMatches: matches
        .slice(1, 6)
        .map((m) => ({ testKey: m.testKey, suite: m.suite, testName: m.testName })),
      verdict,
      latest,
      timeline,
      fingerprint: spread
        ? {
            value: fpValue,
            occurrences: spread.occurrences,
            distinctBranches: spread.distinctBranches,
            distinctCommits: spread.distinctCommits,
            distinctTestKeys: spread.distinctTestKeys,
            firstSeen: spread.firstSeen,
            lastSeen: spread.lastSeen,
          }
        : null,
      blame,
      blameFromLiveDiff,
      history: {
        priorRuns: priorTimeline.length,
        everPassed: input.history.everPassed,
        parentOutcome,
        passedSameCommitOtherAttempt: input.history.passedSameCommitOtherAttempt,
      },
    };
  } finally {
    history.close();
  }
}

async function repoRootOf(repoPath: string): Promise<string> {
  try {
    return (await readGitContext(repoPath)).repoRoot;
  } catch {
    return resolve(repoPath);
  }
}

function makeImportsResolver(repoRoot: string): (file: string) => string[] {
  const cache = new Map<string, string[]>();
  return (file) => {
    const hit = cache.get(file);
    if (hit) return hit;
    let out: string[] = [];
    try {
      const abs = resolve(repoRoot, file);
      if (abs.startsWith(resolve(repoRoot))) {
        out = parseImports(readFileSync(abs, "utf8"));
      }
    } catch {
      /* not in the checkout */
    }
    cache.set(file, out);
    return out;
  };
}
