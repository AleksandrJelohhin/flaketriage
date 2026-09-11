/**
 * triage.ts — escalate the deterministic classifier's `ambiguous` results to a
 * model, in ONE batched request.
 *
 * Never throws for an LLM problem: a failed call, unparseable output, or a
 * payload over the token guardrail leaves the ambiguous verdicts untouched and
 * records the reason in `outcome.error`. The tool stays useful without a model.
 */

import type { GitContext } from "../ingest/git.js";
import type { TriagedResult } from "../pipeline.js";
import { referencedFiles } from "../pipeline.js";
import { redact } from "./payload.js";
import { buildUserPayload, DEFAULT_LIMITS, SYSTEM_PROMPT } from "./prompt.js";
import type { PayloadLimits } from "./prompt.js";
import type { LlmProvider } from "./providers/index.js";
import type { LlmUsage } from "./providers/types.js";
import type { ModelVerdict } from "./schema.js";

export const TOKEN_GUARDRAIL = 100_000;

export interface EscalateOptions {
  limits?: PayloadLimits;
  /** unified diff for the commit (caller fetches it; optional). */
  diff?: string;
  tokenGuardrail?: number;
  /** extra secret patterns from `.flaketriage.yml`'s `redact.patterns`. */
  redactPatterns?: RegExp[] | undefined;
}

export interface EscalationOutcome {
  /** testKey → model verdict, for the failures actually escalated. */
  verdicts: Map<string, ModelVerdict>;
  /** ambiguous failures beyond the per-request cap (no model opinion). */
  deferred: TriagedResult[];
  usage: LlmUsage;
  usd: number;
  cacheHit: boolean;
  model: string;
  /** provider name the request was (or would have been) sent to. */
  provider: string;
  /** number of failures sent to the model. */
  escalated: number;
  /** populated when escalation was skipped or failed; verdicts stays empty. */
  error?: string;
}

const EMPTY_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

export async function escalate(
  ambiguous: TriagedResult[],
  git: GitContext,
  attempt: number,
  provider: LlmProvider,
  opts: EscalateOptions = {},
): Promise<EscalationOutcome> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const guardrail = opts.tokenGuardrail ?? TOKEN_GUARDRAIL;

  const base: Omit<EscalationOutcome, "error"> = {
    verdicts: new Map(),
    deferred: [],
    usage: EMPTY_USAGE,
    usd: 0,
    cacheHit: false,
    model: provider.model,
    provider: provider.name,
    escalated: 0,
  };

  if (ambiguous.length === 0) return base;

  // Guardrail: cap by history depth.
  const ranked = [...ambiguous].sort(
    (a, b) => historyDepth(b) - historyDepth(a),
  );
  const batch = ranked.slice(0, limits.maxFailures);
  const deferred = ranked.slice(limits.maxFailures);

  const framePaths = batch.flatMap((t) =>
    referencedFiles(t.result.failure?.stack, t.result.failure?.message),
  );
  const diff = opts.diff ?? "";
  void framePaths; // diff already prioritised by the caller

  // Data Boundary: redact before this leaves the machine, not after — the
  // request below carries exactly what `--print-payload` would have shown.
  const payload = redact(
    buildUserPayload({ git, attempt, ambiguous: batch, diff }, limits),
    opts.redactPatterns,
  );

  let tokenCount: number;
  try {
    tokenCount = await provider.countTokens(SYSTEM_PROMPT, payload);
  } catch (e) {
    return { ...base, deferred, error: `token count failed: ${errMsg(e)}` };
  }
  if (tokenCount > guardrail) {
    return {
      ...base,
      deferred,
      error: `assembled payload is ~${tokenCount} tokens, over the ${guardrail} guardrail — not escalating`,
    };
  }

  let result;
  try {
    result = await provider.triage(SYSTEM_PROMPT, payload);
  } catch (e) {
    return { ...base, deferred, error: errMsg(e) };
  }

  const byKey = new Map<string, ModelVerdict>();
  for (const v of result.verdicts) byKey.set(v.test_key, v);

  return {
    verdicts: byKey,
    deferred,
    usage: result.usage,
    usd: result.usd,
    cacheHit: result.cacheHit,
    model: result.model,
    provider: provider.name,
    escalated: batch.length,
  };
}

function historyDepth(t: TriagedResult): number {
  // richer verdict evidence ⇒ more history to reason about
  return t.verdict.kind === "ambiguous" ? 0 : t.verdict.evidence.length;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
