"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OpportunityTable } from "@/components/operations/OpportunityTable";
import { ReEngagementTable } from "@/components/operations/ReEngagementTable";
import { BulkActionBar } from "@/components/operations/BulkActionBar";
import { BulkJobBar } from "@/components/operations/BulkJobBar";
import { DecisionDrawer } from "@/components/operations/DecisionDrawer";
import { ListFilterBar } from "@/components/shared/ListFilterBar";
import { LoadMoreFooter } from "@/components/shared/LoadMoreFooter";
import { ErrorState, TableSkeleton } from "@/components/shared/States";
import { useOpportunities } from "@/hooks/useOpportunities";
import { useReEngagement } from "@/hooks/useReEngagement";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { resolveDateRange, DateRangePreset } from "@/lib/dateGroups";
import { downloadFile, ApiError } from "@/lib/api";
import { Download, Loader2 } from "lucide-react";

// COOLING_DOWN/EXHAUSTED aren't RecoveryAttempt statuses — they're payment-level buckets (see
// useReEngagement) rendered through a different table below, not useOpportunities.
const FILTERS = [
  { value: "", label: "All" },
  { value: "AWAITING_APPROVAL", label: "Needs Approval" },
  { value: "PENDING", label: "Pending" },
  { value: "EXECUTED", label: "Executed" },
  { value: "SUCCEEDED", label: "Recovered" },
  { value: "FAILED", label: "Not Recovered" },
  { value: "STOPPED", label: "Stopped" },
  { value: "COOLING_DOWN", label: "Cooling Down" },
  { value: "EXHAUSTED", label: "Exhausted" },
];

export default function OperationsPage() {
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [dateRange, setDateRange] = useState<DateRangePreset>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // "Select all N matching this filter" — a background job over the filter itself rather than an
  // id list, for when there are more matches than could ever be loaded/checked on screen.
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const debouncedQ = useDebouncedValue(q, 300);

  const { from, to } = useMemo(() => resolveDateRange(dateRange), [dateRange]);
  const isReEngagementTab = status === "COOLING_DOWN" || status === "EXHAUSTED";
  const { attempts, total, hasMore, loadMore, isLoading, isLoadingMore, error, mutate } = useOpportunities({
    status: isReEngagementTab ? undefined : status || undefined,
    q: debouncedQ || undefined,
    from,
    to,
  });
  // Both fetched unconditionally (hooks can't be conditional) — whichever the active tab is just
  // gets rendered below. The other one being fetched in the background is harmless and means a
  // tab switch never shows a loading flash.
  const coolingDown = useReEngagement("cooling_down");
  const exhausted = useReEngagement("exhausted");
  const reEngagement = status === "EXHAUSTED" ? exhausted : coolingDown;

  // Only meaningful on the dedicated approval queue tab — that's the only view where `total`
  // (whatever the current status filter is) actually means "total awaiting approval".
  const matchingFilterQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedQ) params.set("q", debouncedQ);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }, [debouncedQ, from, to]);

  // Unlike matchingFilterQuery (bulk actions, which always force AWAITING_APPROVAL server-side),
  // export should reflect whatever tab is actually showing — exporting the "Recovered" tab should
  // only contain recovered attempts.
  const exportFilterQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (debouncedQ) params.set("q", debouncedQ);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }, [status, debouncedQ, from, to]);

  const [exporting, setExporting] = useState(false);
  async function exportCsv() {
    setExporting(true);
    try {
      await downloadFile(`/api/recovery/opportunities/export?${exportFilterQuery}`, "recovery-operations.csv");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not export.");
    } finally {
      setExporting(false);
    }
  }

  // A new filter view can hide/reorder what was selected — start the selection fresh rather than
  // let a bulk-approve silently act on rows the merchant can no longer see.
  useEffect(() => {
    setSelectedIds(new Set());
    setSelectAllMatching(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, debouncedQ, from, to]);

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll(ids: string[], checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Recovery Operations</h1>
        <p className="text-sm text-muted-foreground">
          Every recovery opportunity, its explanation, and the guardrails applied — approve, reject, or execute.
        </p>
      </div>

      <div className="space-y-3">
        <Tabs value={status} onValueChange={setStatus}>
          <TabsList className="flex h-auto flex-wrap justify-start gap-1 bg-transparent p-0">
            {FILTERS.map((f) => (
              <TabsTrigger key={f.value} value={f.value} className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                {f.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {!isReEngagementTab && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <div className="flex-1">
              <ListFilterBar
                q={q}
                onQChange={setQ}
                placeholder="Search by customer name, email, or amount…"
                dateRange={dateRange}
                onDateRangeChange={setDateRange}
              />
            </div>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={exporting} className="shrink-0">
              {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              Export CSV
            </Button>
          </div>
        )}
      </div>

      {isReEngagementTab ? (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <p className="text-sm text-muted-foreground">
              {status === "COOLING_DOWN"
                ? "Stopped for contacting this customer too often — the scheduler automatically retries each once its communication window resets, no approval needed."
                : "Hit the policy's max-retries ceiling after repeated cycles — nothing retries these automatically anymore. Needs a human decision: escalate differently, override, or add to Do-Not-Contact."}
            </p>
            {reEngagement.error ? (
              <ErrorState
                title="Couldn't load this list"
                description={reEngagement.error.message}
                onRetry={() => reEngagement.mutate()}
              />
            ) : reEngagement.isLoading ? (
              <TableSkeleton rows={6} />
            ) : reEngagement.rows.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">Nothing here right now.</p>
            ) : (
              <>
                <ReEngagementTable rows={reEngagement.rows} bucket={status === "EXHAUSTED" ? "exhausted" : "cooling_down"} />
                <LoadMoreFooter
                  shown={reEngagement.rows.length}
                  total={reEngagement.total}
                  hasMore={reEngagement.hasMore}
                  loading={reEngagement.isLoadingMore}
                  onLoadMore={reEngagement.loadMore}
                />
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {selectAllMatching ? (
            <BulkJobBar
              total={total}
              filterQuery={matchingFilterQuery}
              onClear={() => setSelectAllMatching(false)}
              onMutated={() => mutate()}
            />
          ) : (
            <BulkActionBar
              selectedIds={[...selectedIds]}
              onClear={() => setSelectedIds(new Set())}
              onMutated={() => mutate()}
            />
          )}

          <Card>
            <CardContent className="space-y-3 pt-6">
              {error ? (
                <ErrorState title="Couldn't load recovery opportunities" description={error.message} onRetry={() => mutate()} />
              ) : isLoading ? (
                <TableSkeleton rows={6} />
              ) : (
                <>
                  <OpportunityTable
                    attempts={attempts}
                    onSelect={setSelectedId}
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                    onToggleSelectAll={toggleSelectAll}
                    total={total}
                    hasMore={hasMore}
                    onSelectAllMatching={
                      status === "AWAITING_APPROVAL"
                        ? () => {
                            setSelectedIds(new Set());
                            setSelectAllMatching(true);
                          }
                        : undefined
                    }
                  />
                  <LoadMoreFooter shown={attempts.length} total={total} hasMore={hasMore} loading={isLoadingMore} onLoadMore={loadMore} />
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <DecisionDrawer
        attemptId={selectedId}
        onOpenChange={(open) => !open && setSelectedId(null)}
        onMutated={() => mutate()}
      />
    </div>
  );
}
