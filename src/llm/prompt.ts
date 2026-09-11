/**
 * prompt.ts — the frozen system prompt + the per-run user payload.
 *
 * SYSTEM_PROMPT is a module constant with NO interpolation — no timestamps, no
 * run ids, no repo name. It is the cached prefix; any byte change invalidates the
 * cache. Everything volatile goes in the user payload.
 */

import type { GitContext } from "../ingest/git.js";
import type { TriagedResult } from "../pipeline.js";

export const SYSTEM_PROMPT = `You are FlakeTriage's escalation judge. A deterministic classifier has already
handled the clear cases using test history and fingerprinting. You only see the
failures it could not decide — the ambiguous ones.

For each failure decide one of:
  - flake_likely     the failure is non-deterministic: timing, ordering, shared
                     state, environment, network jitter, a race. The code change
                     is probably not the cause.
  - real_regression  the code change under test plausibly broke this. There is a
                     believable path from a changed file to the observed failure.
  - infra_failure    the environment failed: a dependency service, the container,
                     the runner, DNS, disk, a browser that would not start.
  - unknown          the evidence does not clearly support any of the above.

Rules:
  - "unknown" is a valid, expected, and rewarded answer. It is better to say
    "not enough signal" than to invent a cause. Do not guess.
  - Base the verdict on the evidence in the payload only: the failure message,
    the stack frames, the changed files, and the short history summary. Do not
    assume facts that are not there.
  - real_regression needs a concrete link — name the changed file or symbol that
    connects to the failure. If you cannot, it is not a confident real_regression.
  - one_line_reason must be a single plain sentence a developer can act on,
    ideally under 140 characters.
  - suspect_location is "path:line" when the stack or diff points at one, else null.
  - likely_cause is an empty string when kind is "unknown".
  - Echo test_key back exactly as given. Return exactly one verdict per input
    failure, in the same order.`;

export interface PayloadLimits {
  maxFailures: number;
  maxStackLines: number;
  maxMessageChars: number;
  maxDiffLines: number;
}

export const DEFAULT_LIMITS: PayloadLimits = {
  maxFailures: 15,
  maxStackLines: 30,
  maxMessageChars: 2000,
  maxDiffLines: 400,
};

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more lines truncated)`].join(
    "\n",
  );
}

function truncateChars(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}… (truncated)`;
}

export interface UserPayloadInput {
  git: GitContext;
  attempt: number;
  ambiguous: TriagedResult[];
  /** unified diff for the commit, already fetched by the caller (may be empty). */
  diff?: string;
}

/**
 * Build the user message. Prioritises diff hunks for files that appear in a
 * failing stack frame, then truncates to the line budget.
 */
export function buildUserPayload(
  input: UserPayloadInput,
  limits: PayloadLimits = DEFAULT_LIMITS,
): string {
  const { git, attempt, ambiguous } = input;
  const failures = ambiguous.slice(0, limits.maxFailures);

  const parts: string[] = [];
  parts.push(
    `## Run context`,
    `commit: ${git.commitSha}`,
    `parent: ${git.parentSha ?? "(none)"}`,
    `branch: ${git.branch ?? "(detached)"}`,
    `attempt: ${attempt}`,
    `changed files (${git.changedFiles.length}):`,
    ...git.changedFiles.slice(0, 100).map((f) => `  - ${f}`),
    "",
    `## ${failures.length} ambiguous failure(s)`,
  );

  for (const t of failures) {
    const r = t.result;
    parts.push(
      "",
      `### test_key: ${r.testKey}`,
      `suite: ${r.suite}`,
      `name: ${r.name}`,
      `status: ${r.status}`,
      `file: ${r.file ?? "(unknown)"}`,
      `fingerprint: ${r.fingerprint ?? "(none)"}`,
      `message:`,
      truncateChars(r.failure?.message ?? "(no message)", limits.maxMessageChars),
      `stack:`,
      truncateLines(r.failure?.stack ?? "(no stack)", limits.maxStackLines),
    );
  }

  if (input.diff && input.diff.trim().length > 0) {
    parts.push("", `## commit diff (truncated)`, truncateLines(input.diff, limits.maxDiffLines));
  }

  if (ambiguous.length > failures.length) {
    parts.push(
      "",
      `(${ambiguous.length - failures.length} further ambiguous failure(s) omitted from this batch and reported without a model opinion)`,
    );
  }

  return parts.join("\n");
}
