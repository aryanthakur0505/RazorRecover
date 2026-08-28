import { z } from "zod";

// Minimal shape we actually read from Razorpay webhook payloads — we deliberately don't model
// every field Razorpay sends, only what the recovery engine consumes.
export const razorpayWebhookSchema = z.object({
  entity: z.literal("event").optional(),
  event: z.string(),
  created_at: z.number().optional(),
  payload: z.object({
    payment: z
      .object({
        entity: z.object({
          id: z.string(),
          order_id: z.string().nullable().optional(),
          amount: z.number(),
          currency: z.string(),
          status: z.string(),
          method: z.string().nullable().optional(),
          error_code: z.string().nullable().optional(),
          error_description: z.string().nullable().optional(),
          error_reason: z.string().nullable().optional(),
          email: z.string().nullable().optional(),
          contact: z.string().nullable().optional(),
          notes: z.record(z.string(), z.any()).optional(),
          created_at: z.number().optional(),
        }),
      })
      .optional(),
    order: z
      .object({
        entity: z.object({
          id: z.string(),
          amount: z.number(),
          currency: z.string(),
          status: z.string(),
          receipt: z.string().nullable().optional(),
        }),
      })
      .optional(),
  }),
});

export type RazorpayWebhookPayload = z.infer<typeof razorpayWebhookSchema>;
