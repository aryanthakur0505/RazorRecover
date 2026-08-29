import { Router } from "express";
import { prisma } from "../db";
import { requireSession } from "../middleware/session";
import { asyncHandler } from "../middleware/errorHandler";
import { parsePagination, parseDateRange } from "../utils/listQuery";

export const auditRouter = Router();
auditRouter.use(requireSession);

/** Read-only, append-only audit trail. No route in this app ever updates or deletes a row here.
 *  Supports a free-text search (event type, outcome, action, failure reason, or the linked
 *  customer's name/email) plus a date range and real pagination, so an old entry stays findable
 *  no matter how much has been logged since. */
auditRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = (req.query.q as string | undefined)?.trim();
    const { page, pageSize, skip, take } = parsePagination(req, 50, 200);
    const dateFilter = parseDateRange(req, "timestamp");

    const where = {
      merchantId: req.merchantId,
      ...dateFilter,
      ...(q
        ? {
            OR: [
              { eventType: { contains: q, mode: "insensitive" as const } },
              { outcome: { contains: q, mode: "insensitive" as const } },
              { action: { contains: q, mode: "insensitive" as const } },
              { failureReason: { contains: q, mode: "insensitive" as const } },
              { paymentId: q },
              { attemptId: q },
              { payment: { customer: { name: { contains: q, mode: "insensitive" as const } } } },
              { payment: { customer: { email: { contains: q, mode: "insensitive" as const } } } },
            ],
          }
        : {}),
    };

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: { timestamp: "desc" }, skip, take }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({ logs, total, page, pageSize });
  }),
);
