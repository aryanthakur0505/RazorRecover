/**
 * Imports a hand-written (or AI-generated) test dataset and runs every case through the REAL
 * recovery pipeline (classify → score → decide → guardrail → [execute if auto]) — not a raw DB
 * insert. This is what makes it useful as a test: you see exactly what the live decision engine
 * actually does with each case, not just data sitting inert in the database.
 *
 * Usage:
 *   npx tsx scripts/import-test-cases.ts path/to/test-cases.json
 *
 * Input file: a JSON array, see TestCase below for the shape. See PROMPT below (or ask for it)
 * for a ready-to-paste prompt describing this exact format to another AI.
 */
import { prisma } from "../src/db";
import { processFailedPayment } from "../src/services/recoveryOrchestrator";
import { FailureCategory } from "@prisma/client";

interface TestCase {
  label: string; // what this case is meant to prove, e.g. "high score, should auto-retry"
  customerName: string;
  customerEmail: string;
  amountRupees: number;
  failureCategory: FailureCategory;
  isSuspicious?: boolean;
  // Optional: pre-seed this customer with N prior successful payments and/or M prior failed
  // recovery attempts, so the score/comm-limit/history-dependent logic has something real to
  // react to instead of always looking like a brand-new customer.
  priorSuccessfulPayments?: number;
  priorFailedRecoveryAttempts?: number;
}

function r(paise: number) {
  return "Rs " + (paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: npx tsx scripts/import-test-cases.ts path/to/test-cases.json");
    process.exit(1);
  }
  const fs = await import("fs");
  const cases: TestCase[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  console.log(`Loaded ${cases.length} test case(s) from ${filePath}\n`);

  const merchant = await prisma.merchant.findFirstOrThrow();

  for (const [i, tc] of cases.entries()) {
    const customer = await prisma.customer.upsert({
      where: { merchantId_externalRef: { merchantId: merchant.id, externalRef: `testcase-${i}-${tc.customerEmail}` } },
      create: {
        merchantId: merchant.id,
        externalRef: `testcase-${i}-${tc.customerEmail}`,
        name: tc.customerName,
        email: tc.customerEmail,
        isSimulated: true,
      },
      update: {},
    });

    // Optional history seeding -- backdated so it reads as genuine past activity, not something
    // that happened after the payment we're about to test.
    for (let s = 0; s < (tc.priorSuccessfulPayments ?? 0); s++) {
      await prisma.payment.create({
        data: {
          merchantId: merchant.id, customerId: customer.id, amount: Math.round(tc.amountRupees * 100),
          status: "CAPTURED", failureCategory: "NONE", isSimulated: true,
          createdAt: new Date(Date.now() - (s + 10) * 24 * 3600 * 1000),
        },
      });
    }
    for (let f = 0; f < (tc.priorFailedRecoveryAttempts ?? 0); f++) {
      const priorPayment = await prisma.payment.create({
        data: {
          merchantId: merchant.id, customerId: customer.id, amount: Math.round(tc.amountRupees * 100),
          status: "FAILED", failureCategory: tc.failureCategory, failedAt: new Date(Date.now() - (f + 5) * 24 * 3600 * 1000),
          isSimulated: true, createdAt: new Date(Date.now() - (f + 5) * 24 * 3600 * 1000),
        },
      });
      await prisma.recoveryAttempt.create({
        data: {
          paymentId: priorPayment.id, merchantId: merchant.id, attemptNumber: 1, action: "PAYMENT_LINK",
          status: "FAILED", outcome: "NOT_RECOVERED", isSimulated: true,
          idempotencyKey: `testcase-${i}-priorfail-${f}`,
          createdAt: new Date(Date.now() - (f + 5) * 24 * 3600 * 1000),
        },
      });
    }

    // The actual case under test.
    const failedAt = new Date();
    const payment = await prisma.payment.create({
      data: {
        merchantId: merchant.id,
        customerId: customer.id,
        amount: Math.round(tc.amountRupees * 100),
        status: "FAILED",
        failureCategory: tc.failureCategory,
        isSuspicious: !!tc.isSuspicious,
        failedAt,
        isSimulated: true,
      },
    });

    // Real traffic isn't decided the exact instant it fails -- there's always some lag before
    // the system actually gets around to processing it. Without this, every test case scores as
    // if it "just failed this second", which lands in the scoring model's -5 "too fresh" penalty
    // band instead of the +10 "sweet spot" band almost all real (and normally-simulated) traffic
    // gets. Matches simulationService.ts's own real dataset generation exactly (0-6h lag), so a
    // test batch scores comparably to how live/simulated traffic actually would.
    const asOf = new Date(failedAt.getTime() + Math.random() * 6 * 3600 * 1000);
    const attempt = await processFailedPayment(payment.id, { simulate: true, asOf });
    console.log(
      `[${i + 1}/${cases.length}] ${tc.label}\n` +
        `  ${tc.customerName} · ${r(payment.amount)} · ${tc.failureCategory}${tc.isSuspicious ? " (suspicious)" : ""}\n` +
        `  -> action=${attempt.action}  status=${attempt.status}${attempt.outcome ? `  outcome=${attempt.outcome}` : ""}\n`,
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
