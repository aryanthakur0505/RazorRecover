/**
 * Seeds a handful of realistic, individually-named AI-escalated cases for the Shadow Mode demo
 * (Command Center → "AI Impact") — real Groq calls, real deterministic shadow decisions, real
 * scoring off real (backdated) customer history. Safe to re-run any time the DB is reset before
 * a demo: `npm run seed:ai-demo`.
 *
 * Every seed payment is priced above the *live* policy's auto-recovery limit (read fresh each
 * run, not hardcoded) so it always requires approval and never auto-executes through the real
 * Razorpay API. Outcomes are then finalized directly — bypassing only the Razorpay call itself,
 * never the AI or scoring — using the same probability model the rest of the app already relies
 * on. No outcome is cherry-picked: each roll is fair, so the resulting agreement-rate/incremental-
 * net numbers are honest, not staged (they can come out unflattering to the AI, and that's fine —
 * that's the point of measuring instead of assuming).
 *
 * Pass a comma-separated list of case ids as the first CLI arg to run only those (e.g. to add a
 * few more cases without touching/duplicating ones already reviewed):
 *   npx tsx scripts/seed-ai-demo.ts demo-ai-11,demo-ai-12
 */
import { prisma } from "../src/db";
import { processFailedPayment } from "../src/services/recoveryOrchestrator";
import { resolveEscalation, resolveLiveOutcome, executeAttempt } from "../src/services/executionService";

export interface Case {
  id: string;
  name: string;
  amountOverLimit: number; // added on top of the live policy's maxAutoRecoveryAmount (paise) —
  // guarantees requiresApproval=true regardless of AI confidence, so nothing ever auto-executes
  // through the real Razorpay path (whatever the current policy happens to be set to).
  category: "OTHER" | "TEMPORARY_FAILURE" | "INSUFFICIENT_FUNDS";
  attemptNumber?: number; // simulate a second attempt for the "conflicting signal" escalation path
  priorSuccesses?: number; // backdated CAPTURED payments, to give this customer real history
  priorFailedRecoveries?: number; // backdated FAILED recovery attempts
}

// NOTE: SUSPICIOUS_PAYMENT is deliberately excluded — shouldEscalateToAI() always returns false
// for it (never ambiguous, always a clear-cut deterministic STOP/ESCALATE), so it would never
// produce a usedAI=true row for this feature to show. That's correct system behavior, not a gap.
export const CASES: Case[] = [
  { id: "demo-ai-1", name: "Alia Kapoor", amountOverLimit: 50000, category: "OTHER" },
  { id: "demo-ai-2", name: "Rohan Malhotra", amountOverLimit: 200000, category: "OTHER", priorSuccesses: 4 },
  { id: "demo-ai-3", name: "Priya Nair", amountOverLimit: 100000, category: "TEMPORARY_FAILURE", attemptNumber: 2 },
  { id: "demo-ai-4", name: "Karan Mehta", amountOverLimit: 500000, category: "OTHER", priorFailedRecoveries: 1 },
  { id: "demo-ai-5", name: "Ananya Reddy", amountOverLimit: 30000, category: "OTHER", priorFailedRecoveries: 2 },
  { id: "demo-ai-6", name: "Vikram Rao", amountOverLimit: 80000, category: "INSUFFICIENT_FUNDS", priorSuccesses: 2 },
  { id: "demo-ai-7", name: "Sara Khan", amountOverLimit: 1200000, category: "OTHER" },
  { id: "demo-ai-8", name: "Arjun Verma", amountOverLimit: 20000, category: "OTHER", priorSuccesses: 3 },
  { id: "demo-ai-9", name: "Meera Iyer", amountOverLimit: 150000, category: "OTHER", priorSuccesses: 1, priorFailedRecoveries: 1 },
  { id: "demo-ai-10", name: "Ishaan Gupta", amountOverLimit: 300000, category: "TEMPORARY_FAILURE", attemptNumber: 2 },
  // Added to give "Revenue AI Found" (shadow=STOP, AI acted anyway, and it actually worked) a
  // realistic chance to show a real example — same shape as the cases above that already reliably
  // score low enough for the engine to give up (OTHER category, no/weak history), which is what
  // tends to prompt the AI toward ESCALATE. Its 40% manual-resolution success rate isn't tied to
  // the low score the way RETRY/PAYMENT_LINK's would be, so this is the most plausible path to a
  // genuine success — plausible, not guaranteed; the outcome roll is still fair.
  { id: "demo-ai-11", name: "Neha Choudhary", amountOverLimit: 40000, category: "OTHER" },
  { id: "demo-ai-12", name: "Aditya Bhat", amountOverLimit: 60000, category: "OTHER", priorFailedRecoveries: 1 },
  { id: "demo-ai-13", name: "Divya Menon", amountOverLimit: 900000, category: "OTHER" },
  { id: "demo-ai-14", name: "Rahul Saxena", amountOverLimit: 35000, category: "OTHER" },
  { id: "demo-ai-15", name: "Kavya Pillai", amountOverLimit: 700000, category: "OTHER", priorFailedRecoveries: 1 },
  { id: "demo-ai-16", name: "Simran Kaur", amountOverLimit: 45000, category: "OTHER" },
  { id: "demo-ai-17", name: "Yash Trivedi", amountOverLimit: 55000, category: "OTHER" },
  { id: "demo-ai-18", name: "Pooja Bansal", amountOverLimit: 800000, category: "OTHER" },
  { id: "demo-ai-19", name: "Nikhil Chawla", amountOverLimit: 65000, category: "OTHER", priorFailedRecoveries: 1 },
  { id: "demo-ai-20", name: "Tanvi Oberoi", amountOverLimit: 400000, category: "OTHER" },
];

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 3600 * 1000);
}

async function buildHistory(customerId: string, merchantId: string, c: Case) {
  for (let i = 0; i < (c.priorSuccesses ?? 0); i++) {
    await prisma.payment.create({
      data: {
        merchantId,
        customerId,
        amount: 400000 + i * 50000,
        currency: "INR",
        status: "CAPTURED",
        failureCategory: "NONE",
        createdAt: daysAgo(20 + i * 3),
      },
    });
  }
  for (let i = 0; i < (c.priorFailedRecoveries ?? 0); i++) {
    const payment = await prisma.payment.create({
      data: {
        merchantId,
        customerId,
        amount: 300000,
        currency: "INR",
        status: "FAILED",
        failureCategory: "OTHER",
        failedAt: daysAgo(15 + i * 4),
        createdAt: daysAgo(15 + i * 4),
      },
    });
    await prisma.recoveryAttempt.create({
      data: {
        paymentId: payment.id,
        merchantId,
        attemptNumber: 1,
        action: "PAYMENT_LINK",
        status: "FAILED",
        outcome: "NOT_RECOVERED",
        revenueRecovered: 0,
        recoveryCost: 500,
        netRecovered: -500,
        idempotencyKey: `${payment.id}:1:PAYMENT_LINK`,
        createdAt: daysAgo(15 + i * 4),
      },
    });
  }
}

async function runCase(c: Case, merchant: { id: string }, policy: { maxAutoRecoveryAmount: number }): Promise<string> {
  const amount = policy.maxAutoRecoveryAmount + c.amountOverLimit;
  const customer = await prisma.customer.upsert({
    where: { id: c.id },
    create: { id: c.id, merchantId: merchant.id, name: c.name, email: `${c.name.toLowerCase().replace(" ", ".")}@example-customer.test` },
    update: {},
  });

  await buildHistory(customer.id, merchant.id, c);

  const payment = await prisma.payment.create({
    data: {
      merchantId: merchant.id,
      customerId: customer.id,
      amount,
      currency: "INR",
      status: "FAILED",
      failureCategory: c.category,
      failureReasonRaw: "unspecified",
      isSuspicious: false,
      failedAt: new Date(),
    },
  });

  // Simulate a real second attempt for the "conflicting signal" escalation path, if requested.
  if (c.attemptNumber === 2) {
    await prisma.recoveryAttempt.create({
      data: {
        paymentId: payment.id,
        merchantId: merchant.id,
        attemptNumber: 1,
        action: "RETRY",
        status: "FAILED",
        outcome: "NOT_RECOVERED",
        revenueRecovered: 0,
        recoveryCost: 200,
        netRecovered: -200,
        idempotencyKey: `${payment.id}:1:RETRY`,
        createdAt: daysAgo(1),
      },
    });
  }

  const created = await processFailedPayment(payment.id);
  if (!created.usedAI) {
    return `${c.name}: did NOT escalate to AI (score wasn't ambiguous) — skipping.`;
  }
  const shadow = created.shadowDecision as any;
  const roll = Math.random();
  const attemptId = created.id;

  // Defensive: always re-fetch current state rather than trust a snapshot across multiple
  // awaited calls. Critically: NEVER call the real executeAttempt() here for RETRY/PAYMENT_LINK —
  // that's exactly what would call the real Razorpay API for a fake customer. Only ESCALATE and
  // STOP are safe to run through it (performAction is a no-op for both).
  let current = await prisma.recoveryAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  const alreadyTerminal = (s: string) => ["STOPPED", "SUCCEEDED", "FAILED"].includes(s);

  if (current.action === "ESCALATE") {
    if (current.status === "AWAITING_APPROVAL") {
      await prisma.recoveryAttempt.update({ where: { id: attemptId }, data: { status: "APPROVED", approvalStatus: "APPROVED" } });
      await executeAttempt(attemptId); // safe — ESCALATE never calls Razorpay
      current = await prisma.recoveryAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    }
    if (current.status === "EXECUTED") {
      const succeeded = roll < 0.4; // ESCALATION_MANUAL_RESOLUTION_RATE
      await resolveEscalation(attemptId, succeeded, "Demo seed — manual follow-up outcome.");
    }
  } else if (current.action === "STOP") {
    if (!alreadyTerminal(current.status)) {
      await prisma.recoveryAttempt.update({
        where: { id: attemptId },
        data: { status: "STOPPED", approvalStatus: "APPROVED", outcome: "STOPPED_BY_POLICY" },
      });
    }
  } else if (!alreadyTerminal(current.status)) {
    // RETRY / PAYMENT_LINK — finalize by hand, whatever state it's in, without ever routing
    // through executeAttempt/performAction.
    await prisma.recoveryAttempt.update({
      where: { id: attemptId },
      data: {
        status: "EXECUTED",
        approvalStatus: "APPROVED",
        executedAt: new Date(),
        razorpayResponse: { demo: true, note: "Seed data — no real Razorpay call was made." },
      },
    });
    const succeeded = roll < (payment.recoveryScore ?? 30) / 100;
    await resolveLiveOutcome(payment.id, succeeded);
  }

  const fresh = await prisma.recoveryAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  return `${c.name}: AI=${created.action} shadow=${shadow?.action} agreed=${created.action === shadow?.action} status=${fresh.status} net=${fresh.netRecovered}`;
}

async function main() {
  const merchant = await prisma.merchant.findFirstOrThrow();
  const policy = await prisma.recoveryPolicy.findUniqueOrThrow({ where: { merchantId: merchant.id } });
  console.log(`Live maxAutoRecoveryAmount is ₹${policy.maxAutoRecoveryAmount / 100} — every seed case will price above that.`);

  const onlyIds = process.argv[2]?.split(",").map((s) => s.trim());
  const casesToRun = onlyIds ? CASES.filter((c) => onlyIds.includes(c.id)) : CASES;
  if (onlyIds) console.log(`Running only: ${casesToRun.map((c) => c.id).join(", ")}`);

  const results: string[] = [];
  for (const c of casesToRun) {
    results.push(await runCase(c, merchant, policy));
  }
  console.log(results.join("\n"));
}

main()
  .catch((err) => {
    console.error("ERROR:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
