import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { asyncHandler } from "../middleware/errorHandler";
import { chooseOfferTenure, computeEmiPlan, OfferNotOpenError } from "../services/emiService";
import { EMI_TENURE_OPTIONS_MONTHS } from "../types";

/**
 * The ONLY router in this app not behind requireSession — this is the link a real customer
 * opens (no merchant login, no cookie) to actually pick their EMI tenure themselves, instead of
 * the simulated dice roll in emiService.resolveOfferIfDue standing in for them. Keep every
 * response here minimal and scoped to the one plan in the URL: no merchant-wide data, no other
 * customers' information, nothing beyond what's needed to render this one offer and act on it.
 */
export const publicOffersRouter = Router();

publicOffersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const plan = await prisma.installmentPlan.findUnique({
      where: { id: req.params.id },
      include: { customer: { select: { name: true } } },
    });
    if (!plan) {
      res.status(404).json({ error: "This offer link isn't valid." });
      return;
    }
    const options = EMI_TENURE_OPTIONS_MONTHS.map((tenureMonths) => ({
      tenureMonths,
      ...computeEmiPlan(plan.principalAmount, tenureMonths),
    }));
    res.json({
      id: plan.id,
      status: plan.status,
      customerName: plan.customer.name,
      principalAmount: plan.principalAmount,
      annualInterestRateBps: plan.annualInterestRateBps,
      offerExpiresAt: plan.offerExpiresAt,
      chosenTenureMonths: plan.tenureMonths,
      options,
    });
  }),
);

const chooseSchema = z.object({
  tenureMonths: z.union([z.literal(6), z.literal(12), z.literal(24)]),
});

publicOffersRouter.post(
  "/:id/choose",
  asyncHandler(async (req, res) => {
    const body = chooseSchema.parse(req.body);
    try {
      const plan = await chooseOfferTenure(req.params.id, body.tenureMonths);
      res.json({ plan: { id: plan.id, status: plan.status, tenureMonths: plan.tenureMonths, monthlyAmount: plan.monthlyAmount } });
    } catch (err) {
      if (err instanceof OfferNotOpenError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  }),
);
