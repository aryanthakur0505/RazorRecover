import useSWRInfinite from "swr/infinite";
import { ReEngagementRow } from "@/lib/types";

const PAGE_SIZE = 25;

interface ReEngagementPage {
  rows: ReEngagementRow[];
  total: number;
  page: number;
  pageSize: number;
}

function buildKey(pageIndex: number, previousPageData: ReEngagementPage | null, bucket: "cooling_down" | "exhausted") {
  if (previousPageData && previousPageData.rows.length < previousPageData.pageSize) return null;
  const params = new URLSearchParams();
  params.set("bucket", bucket);
  params.set("page", String(pageIndex + 1));
  params.set("pageSize", String(PAGE_SIZE));
  return `/api/recovery/re-engagement?${params.toString()}`;
}

/** "Cooling Down" (will auto-retry once the comms window resets — see backend scheduler.ts) and
 *  "Exhausted" (hit the max-retries ceiling, needs a human decision) — two tabs on Recovery
 *  Operations, same list shape, different bucket. */
export function useReEngagement(bucket: "cooling_down" | "exhausted") {
  const { data, error, isLoading, isValidating, size, setSize, mutate } = useSWRInfinite<ReEngagementPage>(
    (pageIndex, previousPageData) => buildKey(pageIndex, previousPageData, bucket),
    { revalidateFirstPage: true, refreshInterval: 30000 },
  );

  const rows = data?.flatMap((p) => p.rows) ?? [];
  const total = data?.[0]?.total ?? 0;
  const hasMore = rows.length < total;

  return {
    rows,
    total,
    hasMore,
    loadMore: () => setSize(size + 1),
    isLoading: isLoading && !data,
    isLoadingMore: isValidating,
    error,
    mutate,
  };
}
