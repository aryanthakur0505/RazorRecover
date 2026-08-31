/** Removes the seed-ai-demo.ts dataset (demo-ai-1..15) — run before re-seeding for a fresh demo. */
import { prisma } from "../src/db";

async function main() {
  const ids = Array.from({ length: 15 }, (_, i) => `demo-ai-${i + 1}`);
  await prisma.auditLog.deleteMany({ where: { customerId: { in: ids } } });
  await prisma.recoveryAttempt.deleteMany({ where: { payment: { customerId: { in: ids } } } });
  await prisma.payment.deleteMany({ where: { customerId: { in: ids } } });
  await prisma.customer.deleteMany({ where: { id: { in: ids } } });
  console.log("cleared demo-ai-* data");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
