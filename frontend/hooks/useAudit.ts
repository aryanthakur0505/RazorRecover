import useSWRInfinite from "swr/infinite";
import { useEffect } from "react";
import { AuditLogEntry } from "@/lib/types";

const PAGE_SIZE = 50;

export interface AuditFilters {
  q?: string;
  from?: string;
  to?: string;
}

interface AuditPage {
  logs: AuditLogEntry[];
  total: number;
  pageSize: number;
  nextCursor: string | null;
}

// Cursor-based, not page-number-based — see useOpportunities.ts's buildKey doc for why. Every
// action in this app writes an audit row, so offset paging here is especially prone to the same
// "duplicate React key" bug from concurrent inserts.
function buildKey(filters: AuditFilters, previousPageData: AuditPage | null) {
  if (previousPageData && !previousPageData.nextCursor) return null;
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  params.set("pageSize", String(PAGE_SIZE));
  if (previousPageData?.nextCursor) params.set("cursor", previousPageData.nextCursor);
  return `/api/audit?${params.toString()}`;
}

export function useAuditLog(filters: AuditFilters) {
  const filterKey = JSON.stringify(filters);

  const { data, error, isLoading, isValidating, size, setSize, mutate } = useSWRInfinite<AuditPage>(
    (_pageIndex, previousPageData) => buildKey(filters, previousPageData),
    { refreshInterval: 10000, revalidateFirstPage: true },
  );

  useEffect(() => {
    setSize(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  const logs = data?.flatMap((p) => p.logs) ?? [];
  const total = data?.[0]?.total ?? 0;
  const hasMore = logs.length < total;

  return {
    logs,
    total,
    hasMore,
    loadMore: () => setSize(size + 1),
    isLoading: isLoading && !data,
    isLoadingMore: isValidating,
    error,
    mutate,
  };
}
