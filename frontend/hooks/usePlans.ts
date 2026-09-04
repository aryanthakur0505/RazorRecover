import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { useEffect } from "react";
import { InstallmentPlanDetail, InstallmentPlanListRow, InstallmentPlanStatus } from "@/lib/types";

const PAGE_SIZE = 25;

interface PlansPage {
  plans: InstallmentPlanListRow[];
  total: number;
  page: number;
  pageSize: number;
}

function buildKey(pageIndex: number, previousPageData: PlansPage | null, status?: InstallmentPlanStatus | "ALL") {
  if (previousPageData && previousPageData.plans.length < previousPageData.pageSize) return null;
  const params = new URLSearchParams();
  if (status && status !== "ALL") params.set("status", status);
  params.set("page", String(pageIndex + 1));
  params.set("pageSize", String(PAGE_SIZE));
  return `/api/installment-plans?${params.toString()}`;
}

/** List of EMI plans and promises together — a promise is just a plan with tenureMonths === 1,
 *  filterable by lifecycle status the same way either kind resolves (ACTIVE/COMPLETED/DEFAULTED/
 *  CANCELLED). Offset-paginated like the do-not-contact list — this list is written to
 *  infrequently enough (an approval, or a monthly resolution) that the concurrent-insert race
 *  cursor pagination exists for elsewhere isn't a real risk here. */
export function usePlans(status: InstallmentPlanStatus | "ALL") {
  const { data, error, isLoading, isValidating, size, setSize, mutate } = useSWRInfinite<PlansPage>(
    (pageIndex, previousPageData) => buildKey(pageIndex, previousPageData, status),
    { revalidateFirstPage: true, refreshInterval: 20000 },
  );

  useEffect(() => {
    setSize(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const plans = data?.flatMap((p) => p.plans) ?? [];
  const total = data?.[0]?.total ?? 0;
  const hasMore = plans.length < total;

  return {
    plans,
    total,
    hasMore,
    loadMore: () => setSize(size + 1),
    isLoading: isLoading && !data,
    isLoadingMore: isValidating,
    error,
    mutate,
  };
}

export function usePlanDetail(id: string | null) {
  return useSWR<{ plan: InstallmentPlanDetail }>(id ? `/api/installment-plans/${id}` : null, {
    refreshInterval: 15000,
  });
}
