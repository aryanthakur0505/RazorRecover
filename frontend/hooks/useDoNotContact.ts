import useSWRInfinite from "swr/infinite";
import { Customer } from "@/lib/types";

const PAGE_SIZE = 50;

interface DoNotContactPage {
  customers: Customer[];
  total: number;
  page: number;
  pageSize: number;
}

function buildKey(pageIndex: number) {
  const params = new URLSearchParams();
  params.set("doNotContact", "true");
  params.set("page", String(pageIndex + 1));
  params.set("pageSize", String(PAGE_SIZE));
  return `/api/customers?${params.toString()}`;
}

/** The full, paginated do-not-contact exclude list — so a merchant can see and manage everyone
 *  they've excluded in one place, instead of only stumbling onto one at a time from their profile
 *  or a specific attempt. */
export function useDoNotContactList() {
  const { data, error, isLoading, isValidating, size, setSize, mutate } = useSWRInfinite<DoNotContactPage>(
    (pageIndex, previousPageData) => {
      if (previousPageData && previousPageData.customers.length < previousPageData.pageSize) return null;
      return buildKey(pageIndex);
    },
    { revalidateFirstPage: true },
  );

  const customers = data?.flatMap((p) => p.customers) ?? [];
  const total = data?.[0]?.total ?? 0;
  const hasMore = customers.length < total;

  return {
    customers,
    total,
    hasMore,
    loadMore: () => setSize(size + 1),
    isLoading: isLoading && !data,
    isLoadingMore: isValidating,
    error,
    mutate,
  };
}
