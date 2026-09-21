/**
 * shared.ts — action buckets, ordering and cost accounting for every reporter.
 *
 * Section headers are what the reader should DO ("Needs you" / "Safe to ignore"),
 * not the internal taxonomy.
 */

import type { VerdictKind } from "../core/classify.js";
import type { TriagedResult, TriagedRun } from "../pipeline.js";

export type ActionBucket = "needs_you" | "look_soon" | "safe_to_ignore";

export const BUCKET_OF: Record<VerdictKind, ActionBucket> = {
  real_regression: "needs_you",
  always_failing: "look_soon",
  ambiguous: "look_soon",
  infra_failure: "safe_to_ignore",
  flake_confirmed: "safe_to_ignore",
  flake_likely: "safe_to_ignore",
};

export const BUCKET_META: Record<
  ActionBucket,
  { emoji: string; title: string; order: number }
> = {
  needs_you: { emoji: "🔴", title: "Needs you", order: 0 },
  look_soon: { emoji: "🟠", title: "Look when you can", order: 1 },
  safe_to_ignore: { emoji: "⚪", title: "Safe to ignore", order: 2 },
};

/** One-line summary of what each verdict means, for the item lines. */
export const VERDICT_LABEL: Record<VerdictKind, string> = {
  real_regression: "likely broken by this PR",
  always_failing: "already broken / quarantined — not this PR",
  ambiguous: "unclear — not enough signal",
  infra_failure: "infrastructure, not your change",
  flake_confirmed: "confirmed flake",
  flake_likely: "likely flake",
};

/** Section for passing tests that failed first. Informational: never "needs you". */
export const FLAKY_PASS_META = { emoji: "⚪", title: "Passed after retry" } as const;

/** Verdicts that should not, on their own, turn a build red. */
export function isBenign(kind: VerdictKind): boolean {
  return BUCKET_OF[kind] === "safe_to_ignore";
}

export function headline(run: TriagedRun): {
  emoji: string;
  regressions: number;
  needsYou: number;
} {
  const regressions = run.triaged.filter((t) => t.verdict.kind === "real_regression").length;
  const needsYou = run.triaged.filter(
    (t) => BUCKET_OF[t.verdict.kind] === "needs_you",
  ).length;
  const lookSoon = run.triaged.filter(
    (t) => BUCKET_OF[t.verdict.kind] === "look_soon",
  ).length;
  const emoji = needsYou > 0 ? "🔴" : lookSoon > 0 ? "🟠" : "🟢";
  return { emoji, regressions, needsYou };
}

export interface Group {
  bucket: ActionBucket;
  items: TriagedResult[];
}

const KIND_ORDER: VerdictKind[] = [
  "real_regression",
  "always_failing",
  "ambiguous",
  "infra_failure",
  "flake_confirmed",
  "flake_likely",
];

/** Group into action buckets, most-actionable bucket first; strongest item first. */
export function groupByAction(run: TriagedRun): Group[] {
  const byBucket = new Map<ActionBucket, TriagedResult[]>();
  for (const t of run.triaged) {
    const b = BUCKET_OF[t.verdict.kind];
    const list = byBucket.get(b) ?? [];
    list.push(t);
    byBucket.set(b, list);
  }
  const out: Group[] = [];
  for (const bucket of ["needs_you", "look_soon", "safe_to_ignore"] as ActionBucket[]) {
    const items = byBucket.get(bucket);
    if (!items?.length) continue;
    items.sort(
      (a, b) =>
        KIND_ORDER.indexOf(a.verdict.kind) - KIND_ORDER.indexOf(b.verdict.kind) ||
        confRank(b) - confRank(a),
    );
    out.push({ bucket, items });
  }
  return out;
}

function confRank(t: TriagedResult): number {
  return t.verdict.confidence === "high" ? 2 : t.verdict.confidence === "medium" ? 1 : 0;
}

export interface CostAccounting {
  fromHistory: number;
  fromModel: number;
  usd: number;
}

export function accounting(run: TriagedRun): CostAccounting {
  const fromModel = run.triaged.filter((t) => t.verdict.source === "model").length;
  return {
    fromHistory: run.triaged.length - fromModel,
    fromModel,
    usd: run.escalation?.usd ?? 0,
  };
}

export function testTitle(t: TriagedResult): string {
  return `${t.result.suite} › ${t.result.name}`;
}
