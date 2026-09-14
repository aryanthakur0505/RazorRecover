import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler } from "../middleware/errorHandler";
import { requireSession } from "../middleware/session";

export const sessionRouter = Router();

/** Whoever's session cookie this is, if it's still valid — the frontend calls this on load to
 *  decide between the app shell and the login screen. Session bootstrapping itself (signup/login/
 *  logout) lives in routes/auth.ts; this route is read-only. */
sessionRouter.get(
  "/me",
  requireSession,
  asyncHandler(async (req, res) => {
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { id: req.merchantId },
      select: { id: true, name: true, email: true, razorpayKeyId: true, razorpayWebhookSecretEncrypted: true },
    });
    res.json({
      merchantId: merchant.id,
      name: merchant.name,
      email: merchant.email,
      // Whether Razorpay is connected, without ever exposing the credentials themselves — lets the
      // frontend prompt a freshly-signed-up merchant to connect their account before anything that
      // needs it (live webhooks, retries, payment links) can actually do something.
      razorpayConnected: Boolean(merchant.razorpayKeyId && merchant.razorpayWebhookSecretEncrypted),
    });
  }),
);
