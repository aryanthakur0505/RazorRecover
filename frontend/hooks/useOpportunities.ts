import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { useEffect } from "react";
import { RecoveryAttempt } from "@/lib/types";

const PAGE_SIZE = 50;

export interface OpportunityFilters {
  status?: string;
  q?: string;
  from?: string;
  to?: string;
}

interface OpportunitiesPage {
  attempts: RecoveryAttempt[];
  total: number;
  pageSize: number;
  nextCursor: string | null;
}

// Cursor-based, not page-number-based: this list is written to constantly (simulations, the
// scheduler, live webhooks). Offset pagination (page 1 = skip 0, page 2 = skip 50, ...) breaks
// when rows are inserted between fetches — everything shifts down, so "page 2" can re-include a
// row "page 1" already showed, and React sees the same key twice. A cursor anchors each page to
// a specific already-seen row instead of a numeric offset, so concurrent inserts can't shift it.
function buildKey(filters: OpportunityFilters, previousPageData: OpportunitiesPage | null) {
  if (previousPageData && !previousPageData.nextCursor) return null; // no more pages
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.q) params.set("q", filters.q);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  params.set("pageSize", String(PAGE_SIZE));
  if (previousPageData?.nextCursor) params.set("cursor", previousPageData.nextCursor);
  // Encoding every filter into the URL means it doubles as the SWR cache key — no separate
  // key-versioning trick needed to force a fresh cache entry per filter combination.
  return `/api/recovery/opportunities?${params.toString()}`;
}

export function useOpportunities(filters: OpportunityFilters) {
  const filterKey = JSON.stringify(filters);

  const { data, error, isLoading, isValidating, size, setSize, mutate } = useSWRInfinite<OpportunitiesPage>(
    (_pageIndex, previousPageData) => buildKey(filters, previousPageData), // uses the app-wide fetcher registered in SWRProvider
    { refreshInterval: 8000, revalidateFirstPage: true },
  );

  // A new filter set should always start back at page 1 rather than immediately paging deep in.
  useEffect(() => {
    setSize(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  const attempts = data?.flatMap((p) => p.attempts) ?? [];
  const total = data?.[0]?.total ?? 0;
  const hasMore = attempts.length < total;

  return {
    attempts,
    total,
    hasMore,
    loadMore: () => setSize(size + 1),
    isLoading: isLoading && !data,
    isLoadingMore: isValidating,
    error,
    mutate,
  };
}

export function useOpportunity(id: string | null) {
  return useSWR<{ attempt: RecoveryAttempt & { auditLogs: unknown[] } }>(
    id ? `/api/recovery/${id}` : null,
    { refreshInterval: 5000 },
  );
}
