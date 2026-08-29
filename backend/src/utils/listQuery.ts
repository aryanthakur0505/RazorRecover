/** Shared query-string parsing for the paginated, filterable list endpoints (recovery
 *  opportunities, audit trail) — keeps the two routes consistent instead of each rolling
 *  its own page/date parsing. */

import { Request } from "express";

export interface Pagination {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export function parsePagination(req: Request, defaultPageSize = 50, maxPageSize = 200): Pagination {
  const page = Math.max(1, Math.trunc(Number(req.query.page)) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, Math.trunc(Number(req.query.pageSize)) || defaultPageSize));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/** Returns `{ [dateField]: { gte?, lte? } }`, or `{}` if neither `from` nor `to` was given —
 *  spread straight into a Prisma `where` clause. */
export function parseDateRange(req: Request, dateField: string): Record<string, unknown> {
  const from = req.query.from ? new Date(String(req.query.from)) : undefined;
  const to = req.query.to ? new Date(String(req.query.to)) : undefined;
  const range: { gte?: Date; lte?: Date } = {};
  if (from && !Number.isNaN(from.getTime())) range.gte = from;
  if (to && !Number.isNaN(to.getTime())) range.lte = to;
  return Object.keys(range).length > 0 ? { [dateField]: range } : {};
}

/** A free-text search box term parsed as a rupee amount, if it looks like one (e.g. "500" or
 *  "499.50") — so searching "500" also matches a ₹500.00 payment stored as 50000 paise. */
export function parseAmountSearch(q: string): number | undefined {
  if (!/^\d+(\.\d{1,2})?$/.test(q)) return undefined;
  return Math.round(Number(q) * 100);
}
