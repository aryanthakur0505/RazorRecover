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

// --- Cursor pagination -----------------------------------------------------------------------
//
// Plain skip/take offset pagination breaks under concurrent writes: ordered `createdAt desc`,
// if new rows are inserted between fetching page 1 and page 2, everything after them shifts down
// by one position — so "page 2" (still computed as "skip the first N") can re-include a row page 1
// already showed. React then sees the same list key twice ("Encountered two children with the
// same key"). This app writes new rows constantly (simulations, the scheduler, live webhooks), so
// this isn't a rare edge case here — cursor pagination ("give me rows strictly older than the last
// one I saw") is immune to it, since each page is anchored to a specific row instead of a shifting
// numeric offset.

export interface Cursor {
  sortValue: Date;
  id: string;
}

/** Opaque, single-string cursor encoding a row's (sort column, id) — id is the tiebreaker, since
 *  the sort column alone isn't unique (bulk-created rows can share a timestamp to the millisecond). */
export function encodeCursor(sortValue: Date, id: string): string {
  return Buffer.from(`${sortValue.toISOString()}|${id}`).toString("base64url");
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const [iso, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    const sortValue = new Date(iso);
    if (!id || Number.isNaN(sortValue.getTime())) return null;
    return { sortValue, id };
  } catch {
    return null;
  }
}

/** Prisma where-fragment for "strictly before this cursor" under a `<field> desc, id desc`
 *  ordering. `field` is the actual Prisma column name (e.g. "createdAt", "timestamp") — different
 *  models here sort by different columns, so this can't hard-code one. */
export function cursorWhere(field: string, cursor: Cursor | null): Record<string, unknown> {
  if (!cursor) return {};
  return {
    OR: [{ [field]: { lt: cursor.sortValue } }, { [field]: cursor.sortValue, id: { lt: cursor.id } }],
  };
}
