import { Router } from "express";
import { prisma } from "../db";
import { requireSession } from "../middleware/session";
import { asyncHandler } from "../middleware/errorHandler";
import { parsePagination, parseDateRange, encodeCursor, decodeCursor, cursorWhere } from "../utils/listQuery";

export const auditRouter = Router();
auditRouter.use(requireSession);

/** Read-only, append-only audit trail. No route in this app ever updates or deletes a row here.
 *  Supports a free-text search (event type, outcome, action, failure reason, or the linked
 *  customer's name/email) plus a date range and cursor pagination, so an old entry stays findable
 *  no matter how much has been logged since. Cursor-based (not skip/take): every action in the
 *  app writes a row here, so this list changes constantly — offset paging breaks under concurrent
 *  inserts (see listQuery.ts's cursorWhere doc). */
auditRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = (req.query.q as string | undefined)?.trim();
    const { pageSize } = parsePagination(req, 50, 200);
    const dateFilter = parseDateRange(req, "timestamp");
    const cursor = decodeCursor(req.query.cursor as string | undefined);

    const filterWhere = {
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
    const where = { AND: [filterWhere, cursorWhere("timestamp", cursor)] };

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: [{ timestamp: "desc" }, { id: "desc" }], take: pageSize }),
      prisma.auditLog.count({ where: filterWhere }),
    ]);

    const last = logs[logs.length - 1];
    const nextCursor = logs.length === pageSize && last ? encodeCursor(last.timestamp, last.id) : null;

    res.json({ logs, total, pageSize, nextCursor });
  }),
);
