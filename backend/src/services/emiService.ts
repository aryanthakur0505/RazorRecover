import { InstallmentPlan, RecoveryAttempt } from "@prisma/client";
import { prisma } from "../db";
import { writeAudit } from "./auditService";
import {
  EMI_ANNUAL_INTEREST_RATE_BPS,
  EMI_DEFAULT_AFTER_CONSECUTIVE_MISSES,
  EMI_OFFER_ONLY_COST,
  EMI_OFFER_RESPONSE_BOOST,
  EMI_OFFER_WINDOW_DAYS,
  EMI_TENURE_WEIGHTS_BY_AMOUNT,
  EmiTenureMonths,
  RECOVERY_COST,
  SIMULATED_RECOVERY_MAX_PROBABILITY,
  SIMULATED_RECOVERY_MIN_PROBABILITY,
  PAYMENT_LINK_FRICTION_PENALTY,
} from "../types";

const MS_PER_DAY = 24 * 3600 * 1000;
const MS_PER_MONTH = 30 * MS_PER_DAY; // approximate month, consistent with the rest of the codebase's date math

/**
 * Flat/simple interest, deliberately the same rate across every tenure (see
 * EMI_ANNUAL_INTEREST_RATE_BPS) — a longer plan costs more only because interest accrues over
 * more months, not because the rate itself changes. The last installment absorbs whatever paise
 * remainder integer division leaves behind, so the sum of installments always equals
 * totalPayable exactly.
 */
export function computeEmiPlan(principalAmount: number, tenureMonths: EmiTenureMonths) {
  const totalInterest = Math.round(
    (principalAmount * EMI_ANNUAL_INTEREST_RATE_BPS * tenureMonths) / (10_000 * 12),
  );
  const totalPayable = principalAmount + totalInterest;
  const baseMonthly = Math.floor(totalPayable / tenureMonths);
  const installmentAmounts = Array.from({ length: tenureMonths }, (_, i) =>
    i === tenureMonths - 1 ? totalPayable - baseMonthly * (tenureMonths - 1) : baseMonthly,
  );
  return { totalInterest, totalPayable, monthlyAmount: baseMonthly, installmentAmounts };
}

/**
 * Which tenure a *responding* customer picks — not uniform, see EMI_TENURE_WEIGHTS_BY_AMOUNT for
 * the reasoning. Bands are checked in order; the last has maxAmount: Infinity so this always
 * resolves to something.
 */
function weightedTenurePick(principalAmount: number, rng: () => number): EmiTenureMonths {
  const band = EMI_TENURE_WEIGHTS_BY_AMOUNT.find((b) => principalAmount <= b.maxAmount)!;
  const entries = Object.entries(band.weights) as [string, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [tenure, weight] of entries) {
    r -= weight;
    if (r <= 0) return Number(tenure) as EmiTenureMonths;
  }
  return Number(entries[entries.length - 1][0]) as EmiTenureMonths; // floating-point fallback
}

/** Probability the customer responds to the offer at all within the window — separate from (and
 *  more generous than) the per-installment pay probability below, since engaging with an offer
 *  is a lower bar than completing one. */
function offerResponseProbability(recoveryScore: number | null) {
  return Math.min(SIMULATED_RECOVERY_MAX_PROBABILITY, (recoveryScore ?? 30) / 100 + EMI_OFFER_RESPONSE_BOOST);
}

/**
 * Per-installment pay probability for the *simulated* collection model — reuses the same
 * score-driven approach as resolveSimulatedOutcome (score/100 + a flat optimism boost, capped
 * below 1.0), since a customer who's already committed to a plan has shown more resolve than a
 * cold retry/payment-link, not less.
 */
function installmentPayProbability(recoveryScore: number | null) {
  // Same friction reasoning as executionService's PAYMENT_LINK case, not RETRY's optimism boost
  // — an installment (or a promise) is collected by asking the customer to pay each month, not
  // an automatic charge, so it carries the same real-world friction penalty rather than a boost.
  return Math.max(SIMULATED_RECOVERY_MIN_PROBABILITY, (recoveryScore ?? 30) / 100 - PAYMENT_LINK_FRICTION_PENALTY);
}

/**
 * Sends an EMI offer — the FIRST step for an EMI_PLAN attempt, not the whole thing. Creates an
 * InstallmentPlan in OFFERED status with no tenure/installments yet (we don't know the schedule
 * until the customer picks one — see resolveOfferIfDue). Called from executionService.performAction
 * — this is the ONLY place an offer gets created, same one-entry-point discipline as every other
 * action.
 *
 * `backdateForDemo`: when true (simulated attempts only — see call site), the offer's startDate is
 * placed at a random point already inside its own response window instead of "now", and then
 * immediately checked for resolution. This is what makes a freshly-generated simulated dataset
 * show a realistic mix — some offers still waiting, some already accepted (at varying stages of
 * progress), some already expired — instead of every offer starting fresh. A real merchant
 * sending a real offer today never backdates it.
 */
export async function createEmiOffer(
  attempt: RecoveryAttempt & { payment: { amount: number; customerId: string; recoveryScore: number | null } },
  opts: { backdateForDemo?: boolean; rng?: () => number } = {},
): Promise<InstallmentPlan> {
  const { payment } = attempt;
  const rng = opts.rng ?? Math.random;

  const startDate = opts.backdateForDemo
    ? new Date(Date.now() - Math.floor(rng() * (EMI_OFFER_WINDOW_DAYS + 3)) * MS_PER_DAY)
    : new Date();
  const offerExpiresAt = new Date(startDate.getTime() + EMI_OFFER_WINDOW_DAYS * MS_PER_DAY);

  const plan = await prisma.installmentPlan.create({
    data: {
      merchantId: attempt.merchantId,
      paymentId: attempt.paymentId,
      customerId: payment.customerId,
      attemptId: attempt.id,
      principalAmount: payment.amount,
      annualInterestRateBps: EMI_ANNUAL_INTEREST_RATE_BPS,
      status: "OFFERED",
      startDate,
      offerExpiresAt,
    },
  });

  await writeAudit({
    merchantId: attempt.merchantId,
    paymentId: attempt.paymentId,
    customerId: payment.customerId,
    attemptId: attempt.id,
    eventType: "EMI_OFFER_SENT",
    action: "EMI_PLAN",
    amount: payment.amount,
    apiResult: { offerExpiresAt },
  });

  if (opts.backdateForDemo) {
    return resolveOfferIfDue(plan.id, new Date(), rng);
  }
  return plan;
}

/**
 * Checks whether an OFFERED plan's response window has passed as of `asOf`, and if so, resolves
 * it — either the customer picked a tenure (weighted by amount, see weightedTenurePick) and the
 * plan activates, or they never responded and the offer expires, reverting the underlying
 * attempt to FAILED so it flows back into a normal recovery cycle. A no-op if the plan isn't
 * OFFERED, or if the window hasn't closed yet — customers can respond any time up to the
 * deadline, so nothing is decided early.
 */
export async function resolveOfferIfDue(planId: string, asOf: Date, rng: () => number = Math.random) {
  const plan = await prisma.installmentPlan.findUniqueOrThrow({
    where: { id: planId },
    include: { payment: true },
  });
  if (plan.status !== "OFFERED") return plan;
  if (!plan.offerExpiresAt || asOf < plan.offerExpiresAt) return plan;

  const responded = rng() < offerResponseProbability(plan.payment.recoveryScore);
  if (!responded) {
    await prisma.$transaction([
      prisma.installmentPlan.update({ where: { id: plan.id }, data: { status: "EXPIRED" } }),
      prisma.recoveryAttempt.update({
        where: { id: plan.attemptId },
        data: {
          status: "FAILED",
          outcome: "EMI_OFFER_EXPIRED",
          revenueRecovered: 0,
          recoveryCost: EMI_OFFER_ONLY_COST,
          netRecovered: -EMI_OFFER_ONLY_COST,
        },
      }),
    ]);
    await writeAudit({
      merchantId: plan.merchantId,
      paymentId: plan.paymentId,
      customerId: plan.customerId,
      attemptId: plan.attemptId,
      eventType: "EMI_OFFER_EXPIRED",
      outcome: "EMI_OFFER_EXPIRED",
      recoveryCost: EMI_OFFER_ONLY_COST,
      netRecovered: -EMI_OFFER_ONLY_COST,
    });
    return prisma.installmentPlan.findUniqueOrThrow({ where: { id: plan.id } });
  }

  const tenureMonths = weightedTenurePick(plan.principalAmount, rng);
  return activatePlan(plan.id, tenureMonths, asOf, rng);
}

export class OfferNotOpenError extends Error {}

/**
 * The REAL customer choice — called from the public, unauthenticated offer link (see
 * routes/publicOffers.ts), not the simulated dice roll above. A genuine person picked a genuine
 * tenure, so this activates the plan directly with whatever they chose instead of running it
 * through weightedTenurePick. Still enforces the same window: a choice submitted after
 * offerExpiresAt is rejected exactly like a no-response would resolve (see resolveOfferIfDue),
 * not silently honored late.
 */
export async function chooseOfferTenure(planId: string, tenureMonths: EmiTenureMonths) {
  const plan = await prisma.installmentPlan.findUnique({ where: { id: planId } });
  if (!plan) {
    throw new OfferNotOpenError("This offer link isn't valid.");
  }
  if (plan.status !== "OFFERED") {
    throw new OfferNotOpenError(`This offer is ${plan.status.toLowerCase()} and can't be chosen anymore.`);
  }
  if (plan.offerExpiresAt && new Date() > plan.offerExpiresAt) {
    await resolveOfferIfDue(planId, new Date()); // let the normal expiry path own the transition
    throw new OfferNotOpenError("This offer has expired.");
  }
  return activatePlan(planId, tenureMonths, new Date());
}

/** Fills in the schedule once a tenure is known (chosen by the customer, or fixed at 1 for a
 *  promise — see createPromisePlan) and flips the plan ACTIVE. Then resolves whatever
 *  installments are already due as of `asOf`, same backdating-realism reasoning as the offer
 *  step above. */
async function activatePlan(planId: string, tenureMonths: EmiTenureMonths, asOf: Date, rng: () => number = Math.random) {
  const plan = await prisma.installmentPlan.findUniqueOrThrow({ where: { id: planId } });
  const { totalInterest, totalPayable, monthlyAmount, installmentAmounts } = computeEmiPlan(plan.principalAmount, tenureMonths);

  await prisma.installmentPlan.update({
    where: { id: plan.id },
    data: {
      tenureMonths,
      totalInterest,
      totalPayable,
      monthlyAmount,
      status: "ACTIVE",
      installments: {
        create: installmentAmounts.map((amount, i) => ({
          installmentNumber: i + 1,
          dueDate: new Date(plan.startDate.getTime() + (i + 1) * MS_PER_MONTH),
          amount,
        })),
      },
    },
  });

  await writeAudit({
    merchantId: plan.merchantId,
    paymentId: plan.paymentId,
    customerId: plan.customerId,
    attemptId: plan.attemptId,
    eventType: "EMI_OFFER_ACCEPTED",
    action: "EMI_PLAN",
    amount: plan.principalAmount,
    apiResult: { tenureMonths, totalInterest, totalPayable, monthlyAmount },
  });

  return simulateDuePastInstallments(plan.id, asOf, rng);
}

/**
 * A "promise to pay" is really just an installment plan with exactly one installment and no
 * interest, and no offer stage — the customer already committed to a single amount, by a single
 * date, on a follow-up call, so there's nothing to "choose". Reuses the same InstallmentPlan/
 * Installment rows and the same simulateDuePastInstallments resolution logic (a missed promise
 * defaults the "plan" the same way a missed EMI installment would) as the EMI offer flow above —
 * one system instead of two. Called from the approve route, only for an ESCALATE attempt whose
 * approval included a promisedDueDate (see POST /:id/approve).
 *
 * Unlike an EMI plan, the due date is whatever the merchant/customer actually agreed on a call —
 * never auto-computed — so if it's already in the past (a demo backdating it, or a scheduler
 * catching up on a genuinely overdue promise) it resolves immediately; if it's in the future it
 * stays PENDING until that date, resolvable later either by a scheduler pass or a manual mark.
 */
export async function createPromisePlan(
  attempt: RecoveryAttempt & { payment: { amount: number; customerId: string; recoveryScore: number | null } },
  dueDate: Date,
  amount: number,
  opts: { rng?: () => number } = {},
): Promise<InstallmentPlan> {
  const { payment } = attempt;
  const startDate = new Date();

  const plan = await prisma.installmentPlan.create({
    data: {
      merchantId: attempt.merchantId,
      paymentId: attempt.paymentId,
      customerId: payment.customerId,
      attemptId: attempt.id,
      principalAmount: amount,
      tenureMonths: 1,
      annualInterestRateBps: 0,
      totalInterest: 0,
      totalPayable: amount,
      monthlyAmount: amount,
      status: "ACTIVE", // no offer stage -- the commitment is already specific, nothing to choose
      startDate,
      installments: { create: [{ installmentNumber: 1, dueDate, amount }] },
    },
    include: { installments: true },
  });

  await writeAudit({
    merchantId: attempt.merchantId,
    paymentId: attempt.paymentId,
    customerId: payment.customerId,
    attemptId: attempt.id,
    eventType: "PROMISE_MADE",
    action: attempt.action,
    amount,
    apiResult: { dueDate },
  });

  // Resolve immediately if the promised date has already passed (or passes right now for a
  // freshly-backdated demo); otherwise this is a no-op and the promise stays PENDING until its
  // due date, same as a real one would.
  await simulateDuePastInstallments(plan.id, new Date(), opts.rng ?? Math.random);

  return prisma.installmentPlan.findUniqueOrThrow({ where: { id: plan.id } });
}

/**
 * Resolves every PENDING installment whose due date is on/before `asOf`, in order, stopping
 * early if the plan defaults partway through (no point deciding months after a default). Used
 * both by the demo backdating paths above and by whatever later drives real time forward for a
 * live plan (a scheduler pass would call this the same way, one installment at a time, as each
 * due date genuinely arrives — this function doesn't care which case it's in).
 */
export async function simulateDuePastInstallments(planId: string, asOf: Date, rng: () => number = Math.random) {
  const plan = await prisma.installmentPlan.findUniqueOrThrow({
    where: { id: planId },
    include: { installments: { orderBy: { installmentNumber: "asc" } }, payment: true },
  });
  if (plan.status !== "ACTIVE") return plan;
  // ACTIVE always implies a chosen tenure (set together, in activatePlan/createPromisePlan) — the
  // fallback is defensive only and should never actually be exercised.
  const tenureMonths = plan.tenureMonths ?? 1;

  const probability = installmentPayProbability(plan.payment.recoveryScore);
  let consecutiveMisses = 0;

  for (const installment of plan.installments) {
    if (installment.status !== "PENDING") {
      if (installment.status === "MISSED") consecutiveMisses++;
      else consecutiveMisses = 0;
      continue;
    }
    if (installment.dueDate > asOf) break; // future installments stay PENDING — nothing to decide yet

    const paid = rng() < probability;
    await prisma.installment.update({
      where: { id: installment.id },
      data: { status: paid ? "PAID" : "MISSED", paidAt: paid ? installment.dueDate : null },
    });
    // A promise (tenureMonths === 1) gets its own event names — PROMISE_KEPT/PROMISE_BROKEN read
    // better in the audit trail than "installment 1 of 1", and this single event already tells
    // the whole story for a promise, so completePlan/defaultPlan skip writing a second,
    // redundant plan-level event for this case (see below).
    const isPromise = tenureMonths === 1;
    await writeAudit({
      merchantId: plan.merchantId,
      paymentId: plan.paymentId,
      customerId: plan.customerId,
      attemptId: plan.attemptId,
      eventType: isPromise ? (paid ? "PROMISE_KEPT" : "PROMISE_BROKEN") : paid ? "INSTALLMENT_PAID" : "INSTALLMENT_MISSED",
      amount: installment.amount,
      outcome: isPromise ? undefined : `INSTALLMENT_${installment.installmentNumber}_OF_${tenureMonths}`,
    });

    if (paid) {
      consecutiveMisses = 0;
    } else {
      consecutiveMisses++;
      if (consecutiveMisses >= EMI_DEFAULT_AFTER_CONSECUTIVE_MISSES) {
        await defaultPlan(plan.id);
        return prisma.installmentPlan.findUniqueOrThrow({ where: { id: plan.id } });
      }
    }
  }

  // Every installment has now been decided (none left PENDING). A single-installment promise is
  // binary -- one chance, no "consecutive" concept applies, so a miss there is final, same as
  // before (real lenders don't grade a one-off verbal promise on a DPD curve). A real multi-month
  // EMI plan that reaches here never hit EMI_DEFAULT_AFTER_CONSECUTIVE_MISSES in a row above, so
  // per real-world DPD/NPA rules (a customer who resumes paying isn't still in default over one
  // isolated missed month) it closes out successfully via completePlan below, not a default --
  // completePlan itself gives full credit only if every installment was actually paid, and honest
  // partial credit (proportional to what was actually collected) otherwise.
  const refreshed = await prisma.installmentPlan.findUniqueOrThrow({ where: { id: plan.id }, include: { installments: true } });
  const isPromise = (refreshed.tenureMonths ?? tenureMonths) === 1;
  const allPaid = refreshed.installments.every((i) => i.status === "PAID");
  if (isPromise && !allPaid) {
    await defaultPlan(plan.id);
    return prisma.installmentPlan.findUniqueOrThrow({ where: { id: plan.id } });
  }

  return completePlan(plan.id);
}

/**
 * Closes out a plan that finished its full schedule without ever hitting the consecutive-miss
 * default threshold — full credit if every installment was actually paid, honest partial credit
 * (proportional to what was actually collected, same math as defaultPlan's partial credit) if a
 * few non-consecutive installments were missed along the way but the customer kept paying
 * afterward. Mirrors RBI's own DPD/NPA rules: the clock resets once payments resume, so one
 * isolated bad month over a 24-month plan isn't a real default, just a smaller final recovery.
 */
async function completePlan(planId: string) {
  const plan = await prisma.installmentPlan.findUniqueOrThrow({
    where: { id: planId },
    include: { installments: true },
  });
  if (plan.status !== "ACTIVE") return plan;
  if (plan.installments.some((i) => i.status === "PENDING")) return plan; // not finished yet

  const tenureMonths = plan.tenureMonths ?? plan.installments.length;
  const paidCount = plan.installments.filter((i) => i.status === "PAID").length;
  const allPaid = paidCount === plan.installments.length;
  // Recovered revenue is principal only, not principal+interest -- keeps it directly comparable
  // to revenueAtRisk (which was always just the principal), rather than inflating "recovered"
  // with interest income that was never counted as "at risk" in the first place. Partial case
  // prorates that same principal-only figure by how much of the schedule was actually collected.
  const revenueRecovered = allPaid ? plan.principalAmount : Math.round((paidCount / tenureMonths) * plan.principalAmount);

  // A promise (tenureMonths === 1) is a follow-up made DURING an already-charged ESCALATE call —
  // no extra setup cost on top of that, unlike a real EMI plan which is priced for negotiating
  // *and* servicing several months of collection (see RECOVERY_COST.EMI_PLAN vs .ESCALATE). Note
  // this is the cost of an ACCEPTED, completed plan -- a plan that was only offered and never
  // accepted at all is the much smaller EMI_OFFER_ONLY_COST (see resolveOfferIfDue).
  const isPromise = plan.tenureMonths === 1;
  const cost = isPromise ? RECOVERY_COST.ESCALATE : RECOVERY_COST.EMI_PLAN;
  const outcome = allPaid ? "RECOVERED" : "RECOVERED_PARTIAL";

  await prisma.$transaction([
    prisma.installmentPlan.update({ where: { id: plan.id }, data: { status: "COMPLETED" } }),
    prisma.recoveryAttempt.update({
      where: { id: plan.attemptId },
      data: {
        status: "SUCCEEDED",
        outcome,
        revenueRecovered,
        recoveryCost: cost,
        netRecovered: revenueRecovered - cost,
      },
    }),
    prisma.payment.update({ where: { id: plan.paymentId }, data: { status: "CAPTURED" } }),
  ]);
  // The per-installment PROMISE_KEPT audit event above already told the whole story for a
  // 1-installment plan — skip a second, redundant plan-level event for that case.
  if (isPromise) return prisma.installmentPlan.findUniqueOrThrow({ where: { id: plan.id } });
  await writeAudit({
    merchantId: plan.merchantId,
    paymentId: plan.paymentId,
    customerId: plan.customerId,
    attemptId: plan.attemptId,
    eventType: "EMI_PLAN_COMPLETED",
    outcome,
    revenueRecovered,
    recoveryCost: cost,
    netRecovered: revenueRecovered - cost,
  });
  return prisma.installmentPlan.findUniqueOrThrow({ where: { id: plan.id } });
}

/**
 * Broke the plan (too many consecutive misses, or ran out of installments without ever
 * completing) -> attempt FAILED, but with honest partial credit: revenueRecovered is the
 * PRINCIPAL portion of whatever installments were actually paid before the default, not the
 * interest-inclusive sum of those installments and not zero. Payment stays FAILED — the unpaid
 * remainder is genuinely still at risk, and a later cycle can pick it back up as a fresh recovery
 * candidate the same way any other failed attempt does.
 */
async function defaultPlan(planId: string) {
  const plan = await prisma.installmentPlan.findUniqueOrThrow({ where: { id: planId }, include: { installments: true } });
  if (plan.status !== "ACTIVE") return; // already resolved by a concurrent call — same guard as completePlan
  const tenureMonths = plan.tenureMonths ?? 1; // ACTIVE always implies a chosen tenure, see simulateDuePastInstallments
  const isPromise = tenureMonths === 1;
  const cost = isPromise ? RECOVERY_COST.ESCALATE : RECOVERY_COST.EMI_PLAN;
  const outcome = isPromise ? "PROMISE_BROKEN" : "EMI_DEFAULTED";
  const paidCount = plan.installments.filter((i) => i.status === "PAID").length;
  const principalRecovered = Math.round((paidCount / tenureMonths) * plan.principalAmount);

  await prisma.$transaction([
    prisma.installmentPlan.update({ where: { id: plan.id }, data: { status: "DEFAULTED" } }),
    prisma.recoveryAttempt.update({
      where: { id: plan.attemptId },
      data: {
        status: "FAILED",
        outcome,
        revenueRecovered: principalRecovered,
        recoveryCost: cost,
        netRecovered: principalRecovered - cost,
      },
    }),
  ]);
  // Same reasoning as completePlan: the per-installment PROMISE_BROKEN event already told
  // the whole story for a 1-installment plan.
  if (isPromise) return;
  await writeAudit({
    merchantId: plan.merchantId,
    paymentId: plan.paymentId,
    customerId: plan.customerId,
    attemptId: plan.attemptId,
    eventType: "EMI_PLAN_DEFAULTED",
    outcome,
    revenueRecovered: principalRecovered,
    recoveryCost: cost,
    netRecovered: principalRecovered - cost,
  });
}
