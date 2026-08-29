import { prisma } from "../db";
import { executeAttempt } from "./executionService";

const SCAN_INTERVAL_MS = 60_000; // 1 minute — plenty for a hackathon-scale dunning schedule
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Polls for RecoveryAttempts that are due (PENDING with scheduledFor in the past) and runs them
 * through executionService — this is what actually enacts the dunning/retry schedule without
 * requiring Redis/BullMQ, which would be over-engineering for v1.
 */
async function scanDueAttempts() {
  try {
    const due = await prisma.recoveryAttempt.findMany({
      where: { status: "PENDING", scheduledFor: { lte: new Date() } },
      take: 50,
    });
    for (const attempt of due) {
      await executeAttempt(attempt.id, attempt.isSimulated ? { simulate: true } : {}).catch((err) => {
        console.error(`[scheduler] failed executing attempt ${attempt.id}:`, err);
      });
    }
  } catch (err) {
    console.error("[scheduler] scan failed:", err);
  }
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(scanDueAttempts, SCAN_INTERVAL_MS);
  // Kick off one scan shortly after boot too.
  setTimeout(scanDueAttempts, 5_000);
  console.log(`[scheduler] started (interval ${SCAN_INTERVAL_MS}ms)`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
