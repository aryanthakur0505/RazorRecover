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
        maxRetries: 3,
        maxAutoRecoveryAmount: 500000, // ₹5,000
        maxCommunicationsPerPeriod: 2,
        communicationPeriodHours: 72,
        quietHoursStart: 22,
        quietHoursEnd: 8,
        minRetryIntervalMinutes: 60,
        retryDelayMinutes: [0, 360, 1440],
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
