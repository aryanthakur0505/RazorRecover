"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PolicyForm } from "@/components/policies/PolicyForm";
import { DoNotContactList } from "@/components/policies/DoNotContactList";
import { AuditTable } from "@/components/policies/AuditTable";
import { ListFilterBar } from "@/components/shared/ListFilterBar";
import { LoadMoreFooter } from "@/components/shared/LoadMoreFooter";
import { CardSkeleton, ErrorState, TableSkeleton } from "@/components/shared/States";
import { usePolicy } from "@/hooks/usePolicies";
import { useAuditLog } from "@/hooks/useAudit";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { resolveDateRange, DateRangePreset } from "@/lib/dateGroups";
import { ShieldCheck, ScrollText } from "lucide-react";

export default function PoliciesPage() {
  const { data: policyData, error: policyError, isLoading: policyLoading, mutate: mutatePolicy } = usePolicy();

  const [q, setQ] = useState("");
  const [dateRange, setDateRange] = useState<DateRangePreset>("all");
  const debouncedQ = useDebouncedValue(q, 300);
  const { from, to } = useMemo(() => resolveDateRange(dateRange), [dateRange]);

  const {
    logs,
    total,
    hasMore,
    loadMore,
    isLoading: auditLoading,
    isLoadingMore,
    error: auditError,
    mutate: mutateAudit,
  } = useAuditLog({ q: debouncedQ || undefined, from, to });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 font-heading text-2xl font-semibold tracking-tight">
          <ShieldCheck className="size-6 text-chart-1" />
          Policies & Audit
        </h1>
        <p className="text-sm text-muted-foreground">
          Configure the guardrails every recovery action must pass, and review the complete, append-only audit trail.
        </p>
      </div>

      {policyError ? (
        <ErrorState title="Couldn't load policy" description={policyError.message} onRetry={() => mutatePolicy()} />
      ) : policyLoading || !policyData?.policy ? (
        <CardSkeleton />
      ) : (
        <PolicyForm policy={policyData.policy} onSaved={() => mutatePolicy()} />
      )}

      <DoNotContactList />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScrollText className="size-4 text-chart-1" />
            Audit Trail
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ListFilterBar
            q={q}
            onQChange={setQ}
            placeholder="Search by event, outcome, customer name, or email…"
            dateRange={dateRange}
            onDateRangeChange={setDateRange}
          />
          {auditError ? (
            <ErrorState title="Couldn't load audit log" description={auditError.message} onRetry={() => mutateAudit()} />
          ) : auditLoading ? (
            <TableSkeleton rows={8} />
          ) : (
            <>
              <AuditTable logs={logs} />
              <LoadMoreFooter shown={logs.length} total={total} hasMore={hasMore} loading={isLoadingMore} onLoadMore={loadMore} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
