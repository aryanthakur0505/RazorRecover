import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler } from "../middleware/errorHandler";
import { requireSession, setSessionCookie } from "../middleware/session";

export const sessionRouter = Router();

const DEMO_MERCHANT_NAME = "Aurora Retail (Demo)";

/** Mock merchant session: no passwords, no signup — finds or creates a single demo merchant
 *  and issues a signed session cookie. This is intentionally simple per the hackathon scope. */
sessionRouter.post(
  "/init",
  asyncHandler(async (req, res) => {
    let merchant = await prisma.merchant.findFirst({ where: { name: DEMO_MERCHANT_NAME } });
    if (!merchant) {
      merchant = await prisma.merchant.create({ data: { name: DEMO_MERCHANT_NAME } });
      await prisma.recoveryPolicy.create({ data: { merchantId: merchant.id } });
    }
    setSessionCookie(res, merchant.id);
    res.json({ merchantId: merchant.id, name: merchant.name });
  }),
);

sessionRouter.get(
  "/me",
  requireSession,
  asyncHandler(async (req, res) => {
    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { id: req.merchantId } });
    res.json({ merchantId: merchant.id, name: merchant.name });
  }),
);
