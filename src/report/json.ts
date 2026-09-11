/**
 * json.ts — machine-readable triage output (`--format json`).
 */

import type { Proximity } from "../core/blame.js";
import type { TriagedRun } from "../pipeline.js";
import { accounting, BUCKET_OF, headline } from "./shared.js";

export interface JsonReport {
  schema: "flaketriage/triage@2";
  commit: string;
  parent: string | null;
  branch: string | null;
  attempt: number;
  emoji: string;
  totals: {
    total: number;
    passed: number;
    skipped: number;
    failed: number;
    regressions: number;
    needsYou: number;
    ambiguous: number;
  };
  cost: { fromHistory: number; fromModel: number; usd: number };
  escalation?: {
    model: string;
    escalated: number;
    deferred: number;
    cacheHit: boolean;
    error?: string;
  };
  verdicts: {
    testKey: string;
    suite: string;
    name: string;
    status: "failed" | "error";
    fingerprint: string | null;
    kind: string;
    confidence: string;
    evidence: string[];
    source: "history" | "model";
    action: string;
    blame?: {
      file: string;
      line: number | null;
      proximity: Proximity;
      confidence: number;
      changedFile: string;
    }[];
    model?: {
      one_line_reason: string;
      likely_cause: string;
      suspect_location: string | null;
      suggested_next_step: string;
    };
  }[];
}

export function renderJsonReport(run: TriagedRun): JsonReport {
  const { emoji, regressions, needsYou } = headline(run);
  const acc = accounting(run);
  return {
    schema: "flaketriage/triage@2",
    commit: run.git.commitSha,
    parent: run.git.parentSha,
    branch: run.git.branch,
    attempt: run.attempt,
    emoji,
    totals: {
      total: run.total,
      passed: run.passed,
      skipped: run.skipped,
      failed: run.triaged.length,
      regressions,
      needsYou,
      ambiguous: run.ambiguousCount,
    },
    cost: { fromHistory: acc.fromHistory, fromModel: acc.fromModel, usd: acc.usd },
    ...(run.escalation
      ? {
          escalation: {
            model: run.escalation.model,
            escalated: run.escalation.escalated,
            deferred: run.escalation.deferred,
            cacheHit: run.escalation.cacheHit,
            ...(run.escalation.error ? { error: run.escalation.error } : {}),
          },
        }
      : {}),
    verdicts: run.triaged.map((t) => ({
      testKey: t.result.testKey,
      suite: t.result.suite,
      name: t.result.name,
      status: (t.result.status === "error" ? "error" : "failed") as "failed" | "error",
      fingerprint: t.result.fingerprint,
      kind: t.verdict.kind,
      confidence: t.verdict.confidence,
      evidence: t.verdict.evidence,
      source: t.verdict.source,
      action: BUCKET_OF[t.verdict.kind],
      ...(t.verdict.blame && t.verdict.blame.length > 0
        ? {
            blame: t.verdict.blame.map((b) => ({
              file: b.frame.file,
              line: b.frame.line,
              proximity: b.proximity,
              confidence: b.confidence,
              changedFile: b.changedFile,
            })),
          }
        : {}),
      ...(t.model
        ? {
            model: {
              one_line_reason: t.model.one_line_reason,
              likely_cause: t.model.likely_cause,
              suspect_location: t.model.suspect_location,
              suggested_next_step: t.model.suggested_next_step,
            },
          }
        : {}),
    })),
  };
}
