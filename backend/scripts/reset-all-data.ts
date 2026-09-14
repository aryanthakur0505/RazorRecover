/** Wipes every payment/customer/attempt/audit/EMI row for a clean slate — keeps Merchant and
 *  RecoveryPolicy untouched so the demo session/config still works. Deletes in FK-safe order
 *  (children before parents). Run `npm run seed` after this if you also want to re-verify the
 *  merchant+policy row exists (it's idempotent, so it's a safe no-op here). */
import { prisma } from "../src/db";

async function main() {
  console.log("Deleting Installment...");
  const installments = await prisma.installment.deleteMany({});
  console.log("  ->", installments.count);

  console.log("Deleting InstallmentPlan...");
  const plans = await prisma.installmentPlan.deleteMany({});
  console.log("  ->", plans.count);

  console.log("Deleting AuditLog...");
  const audit = await prisma.auditLog.deleteMany({});
  console.log("  ->", audit.count);

  console.log("Deleting RecoveryAttempt...");
  const attempts = await prisma.recoveryAttempt.deleteMany({});
  console.log("  ->", attempts.count);

  console.log("Deleting CustomerNote...");
  const notes = await prisma.customerNote.deleteMany({});
  console.log("  ->", notes.count);

  console.log("Deleting Payment...");
  const payments = await prisma.payment.deleteMany({});
  console.log("  ->", payments.count);

  console.log("Deleting Customer...");
  const customers = await prisma.customer.deleteMany({});
  console.log("  ->", customers.count);

  console.log("Deleting WebhookEvent...");
  const webhooks = await prisma.webhookEvent.deleteMany({});
  console.log("  ->", webhooks.count);

  const merchants = await prisma.merchant.count();
  const policies = await prisma.recoveryPolicy.count();
  console.log(`\nKept ${merchants} merchant(s) and ${policies} policy row(s) untouched.`);
  console.log("Reset complete — database is now a clean slate.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
