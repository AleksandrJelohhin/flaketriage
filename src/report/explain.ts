/**
 * explain.ts — render an {@link ExplainReport} as human-verifiable proof.
 */

import type { ExplainReport } from "../explain.js";
import { VERDICT_LABEL } from "./shared.js";

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}
function sha(s: string): string {
  return s.slice(0, 7);
}

export function renderExplain(r: ExplainReport, color = false): string {
  const bold = (s: string) => (color ? `[1m${s}[22m` : s);
  const dim = (s: string) => (color ? `[2m${s}[22m` : s);
  const out: string[] = [];

  out.push(bold(`${r.suite} › ${r.testName}`));
  out.push(dim(`test_key ${r.testKey.slice(0, 16)}…`));
  if (r.otherMatches.length > 0) {
    out.push(
      dim(
        `  (also matched: ${r.otherMatches
          .map((m) => `${m.suite} › ${m.testName}`)
          .join("; ")})`,
      ),
    );
  }

  // ── verdict ────────────────────────────────────────────────────────────────
  out.push(
    "",
    bold(
      `VERDICT: ${r.verdict.kind}  (${r.verdict.confidence} confidence, ` +
        `${r.verdict.source})  — ${VERDICT_LABEL[r.verdict.kind]}`,
    ),
  );
  for (const e of r.verdict.evidence) out.push(`  • ${e}`);

  // ── timeline ───────────────────────────────────────────────────────────────
  out.push("", bold(`RUN TIMELINE  (${r.timeline.length} recorded)`));
  for (const t of r.timeline.slice(-20)) {
    out.push(
      `  ${fmtDate(t.startedAt)}  ${sha(t.commitSha)}  ` +
        `${(t.branch ?? "—").padEnd(14).slice(0, 14)}  a${t.attempt}  ` +
        `${glyph(t.status)}  ${t.fingerprint ? t.fingerprint.slice(0, 12) : ""}`,
    );
  }
  out.push(
    dim(
      `  history for the classifier: ${r.history.priorRuns} prior run(s), ` +
        `ever passed = ${r.history.everPassed}, ` +
        `parent outcome = ${r.history.parentOutcome ?? "not recorded"}, ` +
        `passed another attempt of this commit = ${r.history.passedSameCommitOtherAttempt}`,
    ),
  );

  // ── fingerprint ────────────────────────────────────────────────────────────
  out.push("", bold("FINGERPRINT"));
  if (r.fingerprint) {
    const f = r.fingerprint;
    out.push(
      `  ${f.value}`,
      `  seen ${f.occurrences} time(s) across ${f.distinctBranches} branch(es), ` +
        `${f.distinctCommits} commit(s), ${f.distinctTestKeys} distinct test(s)`,
      dim(`  first ${fmtDate(f.firstSeen)} · last ${fmtDate(f.lastSeen)}`),
    );
  } else {
    out.push("  (no fingerprint — the failure has no message or stack)");
  }

  // ── blame ──────────────────────────────────────────────────────────────────
  out.push(
    "",
    bold(
      `BLAME  (stack ↔ this PR's changed files` +
        `${r.blameFromLiveDiff ? "" : " — file list only, no live diff"})`,
    ),
  );
  if (r.blame.length === 0) {
    out.push("  no link between a failing frame and a changed file (a valid, common result)");
  } else {
    for (const b of r.blame) {
      out.push(
        `  [${b.confidence.toFixed(2)}] ${b.proximity}: frame ${b.frame.depth} ` +
          `${b.frame.file}${b.frame.line !== null ? `:${b.frame.line}` : ""}` +
          `  ↔  ${b.changedFile}`,
      );
      out.push(dim(`        ${b.frame.raw}`));
    }
  }

  // ── raw failure ────────────────────────────────────────────────────────────
  out.push("", bold("FAILURE (as recorded)"));
  if (r.latest.message) out.push(indent(r.latest.message, 2));
  if (r.latest.stack) out.push(dim(indent(truncate(r.latest.stack, 20), 2)));

  return out.join("\n");
}

function glyph(status: string): string {
  return status === "passed" ? "pass" : status === "skipped" ? "skip" : "FAIL";
}
function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split(/\r?\n/)
    .map((l) => pad + l)
    .join("\n");
}
function truncate(s: string, lines: number): string {
  const l = s.split(/\r?\n/);
  return l.length <= lines ? s : `${l.slice(0, lines).join("\n")}\n  … (${l.length - lines} more)`;
}
