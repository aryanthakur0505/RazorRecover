"use client";

import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OpportunityTable } from "@/components/operations/OpportunityTable";
import { DecisionDrawer } from "@/components/operations/DecisionDrawer";
import { ListFilterBar } from "@/components/shared/ListFilterBar";
import { LoadMoreFooter } from "@/components/shared/LoadMoreFooter";
import { ErrorState, TableSkeleton } from "@/components/shared/States";
import { useOpportunities } from "@/hooks/useOpportunities";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { resolveDateRange, DateRangePreset } from "@/lib/dateGroups";

const FILTERS = [
  { value: "", label: "All" },
  { value: "AWAITING_APPROVAL", label: "Needs Approval" },
  { value: "PENDING", label: "Pending" },
  { value: "EXECUTED", label: "Executed" },
  { value: "SUCCEEDED", label: "Recovered" },
  { value: "FAILED", label: "Not Recovered" },
  { value: "STOPPED", label: "Stopped" },
];

export default function OperationsPage() {
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [dateRange, setDateRange] = useState<DateRangePreset>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const debouncedQ = useDebouncedValue(q, 300);

  const { from, to } = useMemo(() => resolveDateRange(dateRange), [dateRange]);
  const { attempts, total, hasMore, loadMore, isLoading, isLoadingMore, error, mutate } = useOpportunities({
    status: status || undefined,
    q: debouncedQ || undefined,
    from,
    to,
  });

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
        <ListFilterBar
          q={q}
          onQChange={setQ}
          placeholder="Search by customer name, email, or amount…"
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
        />
      </div>

      <Card>
        <CardContent className="space-y-3 pt-6">
          {error ? (
            <ErrorState title="Couldn't load recovery opportunities" description={error.message} onRetry={() => mutate()} />
          ) : isLoading ? (
            <TableSkeleton rows={6} />
          ) : (
            <>
              <OpportunityTable attempts={attempts} onSelect={setSelectedId} />
              <LoadMoreFooter shown={attempts.length} total={total} hasMore={hasMore} loading={isLoadingMore} onLoadMore={loadMore} />
            </>
          )}
        </CardContent>
      </Card>

      <DecisionDrawer
        attemptId={selectedId}
        onOpenChange={(open) => !open && setSelectedId(null)}
        onMutated={() => mutate()}
      />
    </div>
  );
}
