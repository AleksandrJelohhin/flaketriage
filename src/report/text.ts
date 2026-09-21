/**
 * text.ts — terminal-friendly triage report (CLI default `--format text`).
 */

import type { TriagedResult, TriagedRun } from "../pipeline.js";
import {
  accounting,
  BUCKET_META,
  FLAKY_PASS_META,
  groupByAction,
  headline,
  testTitle,
  VERDICT_LABEL,
} from "./shared.js";

export function renderText(run: TriagedRun, color = false): string {
  const bold = (s: string) => (color ? `[1m${s}[22m` : s);
  const dim = (s: string) => (color ? `[2m${s}[22m` : s);

  const { emoji, needsYou } = headline(run);
  const failures = run.triaged.length;
  const out: string[] = [];

  out.push(
    bold(
      `${emoji} FlakeTriage — ${run.passed} passed, ${failures} failed/error, ${run.skipped} skipped`,
    ),
  );
  out.push(
    dim(
      `   commit ${run.git.commitSha.slice(0, 7)}` +
        `${run.git.branch ? ` (${run.git.branch})` : ""} · attempt ${run.attempt}`,
    ),
  );

  if (failures === 0) {
    out.push(...flakyLines(run, bold, dim), "", footer(run, dim));
    return out.join("\n");
  }
  if (needsYou > 0) out.push(dim(`   ${needsYou} need${needsYou === 1 ? "s" : ""} you`));

  for (const group of groupByAction(run)) {
    const meta = BUCKET_META[group.bucket];
    out.push("", bold(`${meta.emoji} ${meta.title}`));
    for (const item of group.items) out.push(...renderItem(item, dim));
  }

  out.push(...flakyLines(run, bold, dim), "", footer(run, dim));
  return out.join("\n");
}

/** Passing tests that failed first. Empty when none. */
function flakyLines(
  run: TriagedRun,
  bold: (s: string) => string,
  dim: (s: string) => string,
): string[] {
  if (run.flakes.length === 0) return [];
  const out = ["", bold(`${FLAKY_PASS_META.emoji} ${FLAKY_PASS_META.title}`)];
  for (const item of run.flakes) out.push(...renderItem(item, dim));
  return out;
}

function renderItem(item: TriagedResult, dim: (s: string) => string): string[] {
  const conf = ` [${item.verdict.confidence}]`;
  const src = item.verdict.source === "model" ? dim(" (model)") : "";
  const label = dim(` — ${VERDICT_LABEL[item.verdict.kind]}`);
  const out = [`  • ${testTitle(item)}${dim(conf)}${label}${src}`];
  for (const sentence of item.verdict.evidence) out.push(dim(`      ${sentence}`));
  if (item.model?.suggested_next_step) {
    out.push(dim(`      → ${item.model.suggested_next_step}`));
  }
  return out;
}

function footer(run: TriagedRun, dim: (s: string) => string): string {
  const acc = accounting(run);
  const bits: string[] = [];
  if (acc.fromHistory > 0) bits.push(`${acc.fromHistory} from history`);
  if (acc.fromModel > 0) bits.push(`${acc.fromModel} from model`);
  if (bits.length === 0) bits.push("0 verdicts");
  let line = `   ${bits.join(", ")} · $${acc.usd.toFixed(2)}`;
  if (run.escalation?.model && acc.fromModel > 0) line += ` · ${run.escalation.model}`;
  if (run.escalation?.error) line += `\n   ! model escalation skipped: ${run.escalation.error}`;
  return dim(line);
}
