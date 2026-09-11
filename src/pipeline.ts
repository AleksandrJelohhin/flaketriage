/**
 * pipeline.ts — turn a parsed run into triaged verdicts.
 *
 * Orchestration layer: reads history + source files (I/O) and calls the pure
 * {@link classify} for every failure. Classification happens BEFORE the run is
 * recorded, so "prior history" means exactly that.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { analyzeResults } from "./core/analyze.js";
import type { AnalyzedResult } from "./core/analyze.js";
import { correlate, parseImports, parseStackFrames } from "./core/blame.js";
import type { BlameLink } from "./core/blame.js";
import { classify } from "./core/classify.js";
import type { ClassifierInput, Verdict } from "./core/classify.js";
import type { History } from "./core/history.js";
import { normalizeFailure } from "./core/normalize.js";
import type { GitContext } from "./ingest/git.js";
import type { TestResult } from "./ingest/junit.js";
import type { EscalationOutcome } from "./llm/triage.js";
import type { ModelVerdict } from "./llm/schema.js";

export interface TriagedResult {
  result: AnalyzedResult;
  verdict: Verdict;
  /** full structured model output, when this verdict was escalated. */
  model?: ModelVerdict;
}

export interface EscalationSummary {
  model: string;
  provider: string;
  /** input tokens actually sent (0 when nothing was escalated). */
  tokens: number;
  usd: number;
  escalated: number;
  deferred: number;
  cacheHit: boolean;
  error?: string;
}

export interface TriagedRun {
  git: GitContext;
  attempt: number;
  total: number;
  passed: number;
  skipped: number;
  /** failures + errors; the reporter orders them most-actionable-first. */
  triaged: TriagedResult[];
  /** verdicts still `ambiguous` after the deterministic (and model) pass. */
  ambiguousCount: number;
  escalation?: EscalationSummary;
}

const SOURCE_EXT =
  /(?:[\w.@/\\-]+)\.(?:tsx?|jsx?|mjs|cjs|py|rb|java|kt|kts|go|php|cs|scala|swift|rs|c|cc|cpp|h|hpp)\b/gi;

/** File paths referenced anywhere in a raw stack / message (for diff prioritisation). */
export function referencedFiles(...blobs: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const blob of blobs) {
    if (!blob) continue;
    for (const m of blob.matchAll(SOURCE_EXT)) {
      out.add(m[0].replace(/\\/g, "/").replace(/^[a-zA-Z]:\//, ""));
    }
  }
  return [...out];
}

function testFileTouched(changed: string[], candidates: string[]): boolean {
  if (candidates.length === 0) return false;
  const changedBases = new Set(
    changed.map((c) => c.replace(/\\/g, "/").split("/").pop()!.toLowerCase()),
  );
  const changedFull = new Set(changed.map((c) => c.replace(/\\/g, "/").toLowerCase()));
  return candidates.some((cand) => {
    const norm = cand.replace(/\\/g, "/").toLowerCase();
    return changedFull.has(norm) || changedBases.has(norm.split("/").pop()!);
  });
}

function testFileCandidates(result: TestResult): string[] {
  const out: string[] = [];
  if (result.file) out.push(result.file.replace(/\\/g, "/"));
  const suite = result.suite;
  if (/^[\w]+(\.[\w]+)+$/.test(suite)) {
    const parts = suite.split(".");
    const last = parts[parts.length - 1]!;
    out.push(`${last}.java`, `${last}.kt`, `${parts.join("/")}.py`, `${last}.py`);
  } else if (/\.\w+$/.test(suite)) {
    out.push(suite.replace(/\\/g, "/"));
  }
  return out;
}

// ── one-level import resolution (I/O — kept out of core/) ─────────────────────

const STRIPPABLE_EXT = /\.(?:tsx?|jsx?|mjs|cjs|py|rb|php)$/;

/**
 * `file → repo-relative files it imports (one level, best-effort)`. Reads each
 * frame's source once, parses imports, resolves `./`- and `../`-relative and
 * python-dotted specifiers. Bare package specifiers are dropped (they never
 * resolve to a repo-relative changed file).
 */
function makeImportsResolver(repoRoot: string): (file: string) => string[] {
  const cache = new Map<string, string[]>();
  return (file) => {
    const cached = cache.get(file);
    if (cached) return cached;
    let out: string[] = [];
    try {
      const abs = resolve(repoRoot, file);
      if (abs.startsWith(resolve(repoRoot))) {
        const src = readFileSync(abs, "utf8");
        const dir = dirname(file.replace(/\\/g, "/"));
        out = parseImports(src)
          .flatMap((spec) => resolveSpec(spec, dir))
          .filter((p): p is string => Boolean(p));
      }
    } catch {
      /* file not in the checkout / unreadable */
    }
    cache.set(file, out);
    return out;
  };
}

function resolveSpec(spec: string, fromDir: string): string[] {
  if (spec.startsWith(".")) {
    const joined = join(fromDir, spec).replace(/\\/g, "/");
    return [joined, joined.replace(STRIPPABLE_EXT, "")];
  }
  if (/^[\w]+(\.[\w]+)+$/.test(spec) && !isAbsolute(spec)) {
    // python-style dotted module → path fragment
    return [spec.replace(/\./g, "/"), `${spec.replace(/\./g, "/")}.py`];
  }
  return [];
}

// ── triage ───────────────────────────────────────────────────────────────────

export interface TriageOptions {
  window?: number;
}

const DEFAULT_WINDOW = 30;

export function triageRun(
  results: TestResult[],
  git: GitContext,
  attempt: number,
  history: History,
  opts: TriageOptions = {},
): TriagedRun {
  const window = opts.window ?? DEFAULT_WINDOW;
  const analyzed = analyzeResults(results, { repoRoot: git.repoRoot });
  const importsOf = makeImportsResolver(git.repoRoot);

  const passed = analyzed.filter((r) => r.status === "passed").length;
  const skipped = analyzed.filter((r) => r.status === "skipped").length;
  const failures = analyzed.filter(
    (r) => r.status === "failed" || r.status === "error",
  );

  const triaged: TriagedResult[] = failures.map((result) => ({
    result,
    verdict: classifyOne(result, git, attempt, history, window, importsOf),
  }));

  return {
    git,
    attempt,
    total: analyzed.length,
    passed,
    skipped,
    triaged,
    ambiguousCount: triaged.filter((t) => t.verdict.kind === "ambiguous").length,
  };
}

export function applyEscalation(run: TriagedRun, outcome: EscalationOutcome): TriagedRun {
  const triaged = run.triaged.map((t): TriagedResult => {
    if (t.verdict.kind !== "ambiguous") return t;
    const mv = outcome.verdicts.get(t.result.testKey);
    if (!mv) return t;
    return { result: t.result, model: mv, verdict: modelToVerdict(mv) };
  });

  return {
    ...run,
    triaged,
    ambiguousCount: triaged.filter((t) => t.verdict.kind === "ambiguous").length,
    escalation: {
      model: outcome.model,
      provider: outcome.provider,
      tokens: outcome.usage.inputTokens,
      usd: outcome.usd,
      escalated: outcome.escalated,
      deferred: outcome.deferred.length,
      cacheHit: outcome.cacheHit,
      ...(outcome.error ? { error: outcome.error } : {}),
    },
  };
}

function modelToVerdict(mv: ModelVerdict): Verdict {
  const evidence = [mv.one_line_reason, mv.likely_cause].filter((s) => s.trim().length > 0);
  const base = { source: "model" as const, evidence };
  switch (mv.kind) {
    case "real_regression":
      return { ...base, kind: "real_regression", confidence: mv.confidence === "high" ? "high" : "medium" };
    case "infra_failure":
      return { ...base, kind: "infra_failure", confidence: "high" };
    case "flake_likely":
      return { ...base, kind: "flake_likely", confidence: "medium" };
    case "unknown":
    default:
      return {
        kind: "ambiguous",
        confidence: "low",
        source: "model",
        evidence: evidence.length > 0 ? evidence : ["the model could not determine a cause"],
      };
  }
}

function classifyOne(
  result: AnalyzedResult,
  git: GitContext,
  attempt: number,
  history: History,
  window: number,
  importsOf: (file: string) => string[],
): Verdict {
  const fingerprint = result.fingerprint ?? "";
  const norm = result.failure
    ? normalizeFailure(result.failure, { repoRoot: git.repoRoot })
    : { message: "", frames: [] as string[], canonical: "" };
  const normalizedText = [norm.message, ...norm.frames].join("\n");

  const fileCandidates = testFileCandidates(result);

  // blame correlation
  const stackFrames = result.failure?.stack ? parseStackFrames(result.failure.stack) : [];
  const blameLinks: BlameLink[] =
    git.diffHunks.length > 0 && stackFrames.length > 0
      ? correlate(stackFrames, git.diffHunks, { importsOf })
      : [];

  const priorTimeline = history.timelineByTestKey(result.testKey);
  const timeline: ClassifierInput["history"]["timeline"] = priorTimeline
    .slice(-window + 1)
    .map((t) => ({
      outcome: t.status === "passed" ? ("pass" as const) : ("fail" as const),
      testFileChanged: testFileTouched(t.changedFiles, fileCandidates),
    }));
  timeline.push({
    outcome: "fail",
    testFileChanged: testFileTouched(git.changedFiles, fileCandidates),
  });

  const parentOutcome = git.parentSha
    ? history.outcomeOnCommit(git.parentSha, result.testKey)
    : null;

  const spread = fingerprint ? history.fingerprintSpread(fingerprint) : null;
  const fingerprintBranches = Math.max(spread?.distinctBranches ?? 0, git.branch ? 1 : 0);

  const input: ClassifierInput = {
    test: {
      testKey: result.testKey,
      suite: result.suite,
      name: result.name,
      file: result.file,
    },
    current: {
      status: result.status === "error" ? "error" : "failed",
      fingerprint,
      normalizedText,
      commitSha: git.commitSha,
      parentSha: git.parentSha,
      attempt,
      changedFiles: git.changedFiles,
      blameLinks,
    },
    history: {
      passedSameCommitOtherAttempt: history.passedInAnotherAttempt(
        git.commitSha,
        result.testKey,
        attempt,
      ),
      everPassed: history.everPassed(result.testKey),
      priorRuns: priorTimeline.length,
      parentOutcome,
      timeline,
      fingerprintBranches,
    },
  };

  return classify(input, { window });
}

/** Re-run the deterministic classifier for one failing result (used by `explain`). */
export function classifyResult(
  result: AnalyzedResult,
  git: GitContext,
  attempt: number,
  history: History,
  window = DEFAULT_WINDOW,
): Verdict {
  return classifyOne(result, git, attempt, history, window, makeImportsResolver(git.repoRoot));
}
