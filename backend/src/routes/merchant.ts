import { Router } from "express";
import { prisma } from "../db";
import { requireSession } from "../middleware/session";
import { asyncHandler } from "../middleware/errorHandler";
import { razorpayCredentialsSchema } from "../schemas/api";
import { encryptSecret } from "../services/crypto";

export const merchantRouter = Router();
merchantRouter.use(requireSession);

/** Connection status + the webhook URL this merchant needs to paste into their own Razorpay
 *  dashboard — never the secrets themselves; see PUT below for why. */
merchantRouter.get(
  "/razorpay-credentials",
  asyncHandler(async (req, res) => {
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { id: req.merchantId },
      select: { razorpayKeyId: true, razorpayKeySecretEncrypted: true, razorpayWebhookSecretEncrypted: true },
    });
    res.json({
      razorpayKeyId: merchant.razorpayKeyId,
      hasKeySecret: Boolean(merchant.razorpayKeySecretEncrypted),
      hasWebhookSecret: Boolean(merchant.razorpayWebhookSecretEncrypted),
      // The frontend already knows its own API base URL (NEXT_PUBLIC_API_URL) and builds the full
      // webhook URL from this — no need for the backend to know its own public origin too.
      webhookPath: `/api/webhooks/razorpay/${req.merchantId}`,
    });
  }),
);

/** Every field is optional and independently settable (see the schema's own doc) — the request
 *  body only ever contains what the merchant actually typed. Secrets are encrypted before they
 *  ever touch the database and are never read back out through this or any other route; the GET
 *  above only ever reports whether one is set, never its value. Sending an empty string clears a
 *  field, e.g. to disconnect after rotating a key in the Razorpay dashboard. */
merchantRouter.put(
  "/razorpay-credentials",
  asyncHandler(async (req, res) => {
    const body = razorpayCredentialsSchema.parse(req.body);
    const data: Record<string, string | null> = {};
    if (body.razorpayKeyId !== undefined) data.razorpayKeyId = body.razorpayKeyId || null;
    if (body.razorpayKeySecret !== undefined) {
      data.razorpayKeySecretEncrypted = body.razorpayKeySecret ? encryptSecret(body.razorpayKeySecret) : null;
    }
    if (body.razorpayWebhookSecret !== undefined) {
      data.razorpayWebhookSecretEncrypted = body.razorpayWebhookSecret ? encryptSecret(body.razorpayWebhookSecret) : null;
    }

    const merchant = await prisma.merchant.update({
      where: { id: req.merchantId },
      data,
      select: { razorpayKeyId: true, razorpayKeySecretEncrypted: true, razorpayWebhookSecretEncrypted: true },
    });
    res.json({
      razorpayKeyId: merchant.razorpayKeyId,
      hasKeySecret: Boolean(merchant.razorpayKeySecretEncrypted),
      hasWebhookSecret: Boolean(merchant.razorpayWebhookSecretEncrypted),
    });
  }),
);
