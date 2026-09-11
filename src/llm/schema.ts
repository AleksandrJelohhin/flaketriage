/**
 * schema.ts — the structured verdict the model must return.
 *
 * `unknown` is a first-class, expected answer: the model is told (in the system
 * prompt) that "not enough signal" beats an invented cause.
 */

import { z } from "zod";

export const ModelVerdictSchema = z.object({
  test_key: z.string().describe("the exact test_key from the input, echoed back"),
  kind: z
    .enum(["flake_likely", "real_regression", "infra_failure", "unknown"])
    .describe("`unknown` when the evidence does not clearly support one of the others"),
  confidence: z.enum(["low", "medium", "high"]),
  one_line_reason: z
    .string()
    .max(200)
    .describe("≤ 140 chars ideally; shown verbatim in the PR comment"),
  likely_cause: z.string().describe("1-3 sentences; empty string if kind is unknown"),
  suspect_location: z
    .string()
    .nullable()
    .describe('e.g. "src/api/client.ts:42", or null'),
  suggested_next_step: z.string().describe("one concrete action for the developer"),
});

export const TriageResponseSchema = z.object({
  verdicts: z.array(ModelVerdictSchema),
});

export type ModelVerdict = z.infer<typeof ModelVerdictSchema>;
export type TriageResponse = z.infer<typeof TriageResponseSchema>;

/** JSON Schema form for OpenAI-compatible `response_format.json_schema`. */
export function triageJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["verdicts"],
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "test_key",
            "kind",
            "confidence",
            "one_line_reason",
            "likely_cause",
            "suspect_location",
            "suggested_next_step",
          ],
          properties: {
            test_key: { type: "string" },
            kind: {
              type: "string",
              enum: ["flake_likely", "real_regression", "infra_failure", "unknown"],
            },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
            one_line_reason: { type: "string" },
            likely_cause: { type: "string" },
            suspect_location: { type: ["string", "null"] },
            suggested_next_step: { type: "string" },
          },
        },
      },
    },
  };
}
