/**
 * cost.ts — pure LLM cost estimation.
 *
 * Escalation batches up to 15 ambiguous failures per request; a typical batch is
 * ~6K input + ~800 output tokens. At Opus 5 rates ($5 / $25 per MTok) that is
 * ≈ $0.05 per batch. Local / free-tier providers cost $0.
 */

export const MAX_FAILURES_PER_BATCH = 15;

/** USD per 1M tokens, by known model. Falls back to Opus-5 rates. */
const RATES: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const TYPICAL_INPUT_TOKENS = 6000;
const TYPICAL_OUTPUT_TOKENS = 800;

export interface CostEstimate {
  failures: number;
  batches: number;
  /** USD to escalate this many ambiguous failures once. */
  usd: number;
  /** the per-batch rate used, for display. */
  perBatchUsd: number;
  free: boolean;
}

export function estimateEscalationCost(
  ambiguousFailures: number,
  opts: { model?: string | undefined; free?: boolean } = {},
): CostEstimate {
  const batches = Math.ceil(Math.max(ambiguousFailures, 0) / MAX_FAILURES_PER_BATCH);
  if (opts.free) {
    return { failures: ambiguousFailures, batches, usd: 0, perBatchUsd: 0, free: true };
  }
  const rate = RATES[opts.model ?? "claude-opus-5"] ?? RATES["claude-opus-5"]!;
  const perBatchUsd =
    (TYPICAL_INPUT_TOKENS / 1e6) * rate.input +
    (TYPICAL_OUTPUT_TOKENS / 1e6) * rate.output;
  return {
    failures: ambiguousFailures,
    batches,
    usd: batches * perBatchUsd,
    perBatchUsd,
    free: false,
  };
}
