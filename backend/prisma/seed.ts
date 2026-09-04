import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const name = "Aurora Retail (Demo)";
  let merchant = await prisma.merchant.findFirst({ where: { name } });
  if (!merchant) {
    merchant = await prisma.merchant.create({ data: { name } });
    console.log(`Created demo merchant: ${merchant.id}`);
  } else {
    console.log(`Demo merchant already exists: ${merchant.id}`);
  }

  const existingPolicy = await prisma.recoveryPolicy.findUnique({ where: { merchantId: merchant.id } });
  if (!existingPolicy) {
    await prisma.recoveryPolicy.create({
      data: {
        merchantId: merchant.id,
        maxRetries: 5,
        maxAutoRecoveryAmount: 500000, // ₹5,000
        maxCommunicationsPerPeriod: 2,
        communicationPeriodHours: 72,
        // Matches RBI's Fair Practices Code for recovery contact: agents/automated messages are
        // only allowed 8 AM-7 PM, not up to 10 PM -- calling/messaging after 7 PM is a real
        // violation, not just bad manners.
        quietHoursStart: 19,
        quietHoursEnd: 8,
        minRetryIntervalMinutes: 60,
        // Evenly spaced every 2 days (0, 2d, 4d, 6d, 8d) instead of a couple of big jumps then
        // giving up — see schema.prisma's RecoveryPolicy.retryDelayMinutes for the full reasoning.
        retryDelayMinutes: [0, 2880, 5760, 8640, 11520],
      },
    });
    console.log("Created default recovery policy.");
  } else {
    console.log("Recovery policy already exists.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
