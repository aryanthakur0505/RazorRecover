import { prisma } from "../src/db";

async function main() {
  const attempts = await prisma.recoveryAttempt.groupBy({
    by: ["status", "outcome"],
    _count: true,
  });
  console.log("--- status x outcome breakdown ---");
  for (const row of attempts.sort((a, b) => b._count - a._count)) {
    console.log(`${row.status.padEnd(18)} outcome=${(row.outcome ?? "null").padEnd(20)} count=${row._count}`);
  }

  const total = await prisma.recoveryAttempt.count();
  const stopped = await prisma.recoveryAttempt.count({ where: { status: "STOPPED" } });
  const failed = await prisma.recoveryAttempt.count({ where: { status: "FAILED" } });
  const failedApiError = await prisma.recoveryAttempt.count({ where: { status: "FAILED", outcome: "API_ERROR" } });
  const failedNotRecovered = await prisma.recoveryAttempt.count({ where: { status: "FAILED", outcome: "NOT_RECOVERED" } });
  const succeeded = await prisma.recoveryAttempt.count({ where: { status: "SUCCEEDED" } });
  const awaiting = await prisma.recoveryAttempt.count({ where: { status: "AWAITING_APPROVAL" } });

  console.log("\n--- summary ---");
  console.log("total:", total);
  console.log("STOPPED (never attempted, blocked by score/policy):", stopped, `(${((stopped/total)*100).toFixed(1)}%)`);
  console.log("FAILED - genuinely not recovered:", failedNotRecovered);
  console.log("FAILED - API_ERROR (infra, not a real recovery failure):", failedApiError);
  console.log("SUCCEEDED:", succeeded);
  console.log("AWAITING_APPROVAL:", awaiting);

  // Of the STOPPED ones, break down by stopReason (stored in outcome for policy-blocked, or check policyChecks)
  const stoppedRows = await prisma.recoveryAttempt.findMany({ where: { status: "STOPPED" }, select: { outcome: true } });
  const stopReasons = new Map<string, number>();
  for (const r of stoppedRows) {
    const key = r.outcome ?? "unknown";
    stopReasons.set(key, (stopReasons.get(key) ?? 0) + 1);
  }
  console.log("\n--- why STOPPED ---");
  for (const [reason, count] of [...stopReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${reason.padEnd(30)} ${count}`);
  }
}
main().finally(() => prisma.$disconnect());
