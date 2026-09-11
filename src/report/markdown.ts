/**
 * markdown.ts — the sticky PR comment / job summary.
 *
 * Grouped by what the reader should DO. Never exceed ~40 lines. Always show the
 * cost line and which verdicts came from history vs the model. Carries the hidden
 * marker so the Action updates the comment in place.
 */

import type { VerdictKind } from "../core/classify.js";
import type { TriagedResult, TriagedRun } from "../pipeline.js";
import {
  accounting,
  BUCKET_META,
  groupByAction,
  headline,
  testTitle,
  VERDICT_LABEL,
} from "./shared.js";
import type { Group } from "./shared.js";

export const STICKY_MARKER = "<!-- flaketriage -->";

const MAX_ITEMS_PER_GROUP = 8;

export function renderMarkdown(run: TriagedRun): string {
  const { emoji, needsYou } = headline(run);
  const failures = run.triaged.length;
  const lines: string[] = [STICKY_MARKER];

  if (failures === 0) {
    lines.push(`### ${emoji} FlakeTriage — no failures`, "", footer(run));
    return lines.join("\n");
  }

  lines.push(
    `### ${emoji} FlakeTriage — ${failures} failure${failures === 1 ? "" : "s"}, ` +
      (needsYou > 0
        ? `${needsYou} need${needsYou === 1 ? "s" : ""} you`
        : "none need you"),
  );

  for (const group of groupByAction(run)) {
    const meta = BUCKET_META[group.bucket];
    lines.push("", `**${meta.emoji} ${meta.title} — ${bucketSummary(group)}**`);
    for (const item of group.items.slice(0, MAX_ITEMS_PER_GROUP)) {
      lines.push(...renderItem(item, run.git.changedFiles));
    }
    const hidden = group.items.length - MAX_ITEMS_PER_GROUP;
    if (hidden > 0) lines.push(`- …and ${hidden} more`);
  }

  lines.push("", footer(run));
  return lines.join("\n");
}

function bucketSummary(group: Group): string {
  const n = group.items.length;
  const kinds = group.items.map((t) => t.verdict.kind);
  const uniq = [...new Set(kinds)];
  if (group.bucket === "safe_to_ignore") {
    const flakes = kinds.filter((k) => k === "flake_confirmed" || k === "flake_likely").length;
    const infra = kinds.filter((k) => k === "infra_failure").length;
    const parts: string[] = [];
    if (flakes) parts.push(`${flakes} flake${flakes === 1 ? "" : "s"}`);
    if (infra) parts.push(`${infra} infra failure${infra === 1 ? "" : "s"}`);
    return parts.join(", ");
  }
  if (uniq.length === 1) return `${n} ${VERDICT_LABEL[uniq[0]!]}`;
  return `${n} item${n === 1 ? "" : "s"}`;
}

function renderItem(item: TriagedResult, changedFiles: string[]): string[] {
  const tag = item.verdict.source === "model" ? " _(model)_" : "";
  const out = [`- \`${testTitle(item)}\`${tag}`];
  for (const sentence of item.verdict.evidence.slice(0, 2)) {
    out.push(`  ${sentence}`);
  }
  const next = item.model?.suggested_next_step ?? startHint(item, changedFiles);
  if (next) out.push(`  → ${next}`);
  return out;
}

const SRC_LOC =
  /([\w./\\-]+\.(?:tsx?|jsx?|mjs|cjs|py|rb|java|kt|go|php|cs|scala|rs)):(\d+)/g;

/** For a regression, point at the strongest blame link, else a changed-file frame. */
function startHint(item: TriagedResult, changedFiles: string[]): string | null {
  if (item.verdict.kind !== "real_regression") return null;
  const link = item.verdict.blame?.[0];
  if (link?.frame.line != null) {
    return `Start at \`${link.frame.file}:${link.frame.line}\``;
  }
  const stack = item.result.failure?.stack;
  if (!stack) return null;
  const changedBases = new Set(
    changedFiles.map((f) => f.replace(/\\/g, "/").split("/").pop()!.toLowerCase()),
  );
  const locs = [...stack.matchAll(SRC_LOC)].map((m) => ({
    file: m[1]!.replace(/\\/g, "/"),
    line: m[2]!,
  }));
  const pick =
    locs.find((l) => changedBases.has(l.file.split("/").pop()!.toLowerCase())) ?? locs[0];
  return pick ? `Start at \`${pick.file}:${pick.line}\`` : null;
}

function footer(run: TriagedRun): string {
  const acc = accounting(run);
  const bits: string[] = [];
  if (acc.fromHistory > 0) bits.push(`${acc.fromHistory} from history`);
  if (acc.fromModel > 0) bits.push(`${acc.fromModel} from model`);
  if (bits.length === 0) bits.push("0 verdicts");

  const parts = [
    `FlakeTriage · ${bits.join(", ")} · $${acc.usd.toFixed(2)}`,
    `commit ${run.git.commitSha.slice(0, 7)}`,
  ];
  const first = firstActionable(run.triaged);
  if (first) parts.push(`<code>flaketriage explain "${first.result.name}"</code>`);
  if (run.escalation?.deferred) parts.push(`${run.escalation.deferred} not escalated`);
  if (run.escalation?.error) parts.push(`model skipped: ${run.escalation.error}`);
  return `<sub>${parts.join(" · ")}</sub>`;
}

function firstActionable(triaged: TriagedResult[]): TriagedResult | undefined {
  const order: VerdictKind[] = ["real_regression", "always_failing", "ambiguous"];
  for (const k of order) {
    const hit = triaged.find((t) => t.verdict.kind === k);
    if (hit) return hit;
  }
  return undefined;
}
