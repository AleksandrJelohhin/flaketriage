/**
 * summary.ts — the GitHub Actions job summary ("end of run" report).
 *
 * The sticky PR comment (markdown.ts) is deliberately capped at ~40 lines so it
 * stays skimmable inline on the Conversation tab. The job summary lives on its
 * own page with no such pressure, so this renders every failure in full: the
 * evidence, the blame table, the model's reasoning, and the raw failure — what
 * a reader needs to trust (or dispute) a verdict without re-running the suite,
 * modelled on how test-reporter / Playwright / Codecov-style CI summaries lay
 * out a run: a stats table up top, drill-down `<details>` per item below.
 */

import type { BlameLink } from "../core/blame.js";
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

const STACK_LINES = 15;

export function renderSummary(run: TriagedRun): string {
  const { emoji, needsYou } = headline(run);
  const failures = run.triaged.length;
  const acc = accounting(run);
  const lines: string[] = [];

  lines.push(`## ${emoji} FlakeTriage`, "");
  lines.push(...runInfoLine(run));
  lines.push("", ...statsTable(run));

  if (failures === 0) {
    lines.push("", "No failures on this run.");
    return lines.join("\n");
  }

  lines.push(
    "",
    needsYou > 0
      ? `**${needsYou} failure${needsYou === 1 ? "" : "s"} need${needsYou === 1 ? "s" : ""} you.**`
      : "**Nothing here needs you** — see *Safe to ignore* for why.",
  );

  for (const group of groupByAction(run)) {
    const meta = BUCKET_META[group.bucket];
    lines.push("", `### ${meta.emoji} ${meta.title} (${group.items.length})`);
    for (const item of group.items) {
      lines.push("", ...renderItem(item, group.bucket === "needs_you"));
    }
  }

  lines.push("", ...footer(run, acc));
  return lines.join("\n");
}

function runInfoLine(run: TriagedRun): string[] {
  const bits = [
    `commit \`${run.git.commitSha.slice(0, 7)}\``,
    run.git.branch ? `branch \`${run.git.branch}\`` : null,
    run.git.parentSha ? `parent \`${run.git.parentSha.slice(0, 7)}\`` : null,
    `attempt ${run.attempt}`,
  ].filter((s): s is string => s !== null);
  return [bits.join(" · ")];
}

function statsTable(run: TriagedRun): string[] {
  const { needsYou } = headline(run);
  const acc = accounting(run);
  const header = ["Total", "Passed", "Failed", "Skipped", "Needs you", "Cost"];
  const values = [
    String(run.total),
    String(run.passed),
    String(run.triaged.length),
    String(run.skipped),
    String(needsYou),
    `$${acc.usd.toFixed(2)}`,
  ];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    `| ${values.join(" | ")} |`,
  ];
}

function renderItem(item: TriagedResult, openByDefault: boolean): string[] {
  const conf = item.verdict.confidence;
  const src = item.verdict.source === "model" ? " · model" : " · history";
  const summary =
    `<code>${escapeHtml(testTitle(item))}</code> — ${VERDICT_LABEL[item.verdict.kind]} ` +
    `(${conf} confidence${src})`;

  const body: string[] = [];
  body.push("**Evidence**");
  for (const e of item.verdict.evidence) body.push(`- ${e}`);

  if (item.model) {
    body.push("", "**Model reasoning**");
    body.push(`- likely cause: ${item.model.likely_cause}`);
    if (item.model.suspect_location) body.push(`- suspect location: \`${item.model.suspect_location}\``);
  }

  if (item.verdict.blame && item.verdict.blame.length > 0) {
    body.push("", "**Blame** (stack frame ↔ changed file)");
    body.push(...blameTable(item.verdict.blame));
  }

  const next = item.model?.suggested_next_step;
  if (next) body.push("", `**Next step:** ${next}`);

  const failure = item.result.failure;
  if (failure && (failure.message || failure.stack)) {
    body.push("", "**Failure**");
    if (failure.message) body.push("```", truncate(failure.message, STACK_LINES), "```");
    if (failure.stack) body.push("```", truncate(failure.stack, STACK_LINES), "```");
  }

  body.push("", `<sub><code>flaketriage explain "${escapeHtml(item.result.name)}"</code></sub>`);

  return [
    `<details${openByDefault ? " open" : ""}>`,
    `<summary>${summary}</summary>`,
    "",
    ...body,
    "",
    "</details>",
  ];
}

function blameTable(links: BlameLink[]): string[] {
  const header = ["Confidence", "Proximity", "Frame", "Changed file"];
  const rows = links.map((l) => [
    l.confidence.toFixed(2),
    l.proximity,
    `\`${l.frame.file}${l.frame.line !== null ? `:${l.frame.line}` : ""}\``,
    `\`${l.changedFile}\``,
  ]);
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ];
}

function footer(run: TriagedRun, acc: ReturnType<typeof accounting>): string[] {
  const bits: string[] = [];
  if (acc.fromHistory > 0) bits.push(`${acc.fromHistory} from history`);
  if (acc.fromModel > 0) bits.push(`${acc.fromModel} from model`);
  if (bits.length === 0) bits.push("0 verdicts");
  const parts = [bits.join(", "), `$${acc.usd.toFixed(2)}`];
  if (run.escalation?.model && acc.fromModel > 0) parts.push(run.escalation.model);
  if (run.escalation?.deferred) parts.push(`${run.escalation.deferred} not escalated`);

  const out = ["---", `<sub>FlakeTriage · ${parts.join(" · ")}</sub>`];
  if (run.escalation?.error) out.push(`<sub>⚠️ model escalation skipped: ${run.escalation.error}</sub>`);
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string, lines: number): string {
  const l = s.split(/\r?\n/);
  return l.length <= lines ? s : `${l.slice(0, lines).join("\n")}\n… (${l.length - lines} more line(s))`;
}
