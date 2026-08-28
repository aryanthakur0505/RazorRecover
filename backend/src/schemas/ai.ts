import { z } from "zod";

/**
 * Strict schema the AI agent's final structured output must satisfy. Validated server-side
 * with Zod regardless of what OpenAI's structured-output guarantees claim — invalid output is
 * never executed, only escalated to a human.
 */
export const aiRecommendationSchema = z.object({
  cause: z.string().min(1).max(300),
  confidence_score: z.number().min(0).max(1),
  risk_flags: z.array(z.string()).max(10),
  recommended_action: z.enum(["RETRY", "PAYMENT_LINK", "STOP", "ESCALATE"]),
  recommended_channel: z.enum(["AUTO_DEBIT", "PAYMENT_LINK", "NONE"]),
  decision_factors: z
    .array(
      z.object({
        factor: z.string(),
        detail: z.string(),
      }),
    )
    .max(8),
});

export type AIRecommendation = z.infer<typeof aiRecommendationSchema>;

export const aiRecommendationJsonSchema = {
  name: "submit_recovery_recommendation",
  description:
    "Submit a structured recovery recommendation. This does NOT execute anything — it is only a recommendation that the backend policy engine will evaluate.",
  strict: true,
  schema: {
    type: "object",
    properties: {
      cause: { type: "string", description: "One-sentence plain-English cause of the failure." },
      confidence_score: { type: "number", description: "0-1 confidence in this recommendation." },
      risk_flags: {
        type: "array",
        items: { type: "string" },
        description: "Short risk tags, e.g. 'first_time_customer', 'high_amount'.",
      },
      recommended_action: {
        type: "string",
        enum: ["RETRY", "PAYMENT_LINK", "STOP", "ESCALATE"],
      },
      recommended_channel: {
        type: "string",
        enum: ["AUTO_DEBIT", "PAYMENT_LINK", "NONE"],
      },
      decision_factors: {
        type: "array",
        items: {
          type: "object",
          properties: {
            factor: { type: "string" },
            detail: { type: "string" },
          },
          required: ["factor", "detail"],
          additionalProperties: false,
        },
      },
    },
    required: [
      "cause",
      "confidence_score",
      "risk_flags",
      "recommended_action",
      "recommended_channel",
      "decision_factors",
    ],
    additionalProperties: false,
  },
} as const;
