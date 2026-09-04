"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { EmptyState, ErrorState, CardSkeleton } from "@/components/shared/States";
import { useOutcomeFunnel } from "@/hooks/useDashboard";
import { formatCurrency } from "@/lib/format";
import { Filter } from "lucide-react";

function Stage({
  label,
  detail,
  amount,
  count,
  widthPct,
  colorClass,
}: {
  label: string;
  detail: string;
  amount: number;
  count: number;
  widthPct: number;
  colorClass: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium">{label}</p>
        <p className="font-mono text-sm tabular-nums text-muted-foreground">
          {formatCurrency(amount)} · {count.toLocaleString()} payment{count === 1 ? "" : "s"}
        </p>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-muted">
        <div className={colorClass} style={{ width: `${widthPct}%`, height: "100%" }} />
      </div>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

export function OutcomeFunnelCard() {
  const { data, error, isLoading, mutate } = useOutcomeFunnel();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Filter className="size-4 text-chart-1" />
          Outcome Funnel
        </CardTitle>
        <CardDescription>
          &quot;Revenue Recovered ÷ Revenue at Risk&quot; compares recovered money against money that was
          never actually pursued — most failed revenue gets filtered out before any attempt, on purpose,
          to avoid spending communication/API budget on low-probability leads. This splits that out so the
          real recovery rate (Recovered ÷ Attempted) isn&apos;t hidden behind it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <ErrorState title="Couldn't load the outcome funnel" description={error.message} onRetry={() => mutate()} />
        ) : isLoading || !data ? (
          <CardSkeleton />
        ) : data.totalFailedCount === 0 ? (
          <EmptyState
            icon={Filter}
            title="No failed payments yet"
            description="This fills in once payments start failing — from live traffic or a simulation."
          />
        ) : (
          <div className="space-y-5">
            <Stage
              label="Total Failed"
              detail="Every payment that ever failed, regardless of what happened to it since."
              amount={data.totalFailedAmount}
              count={data.totalFailedCount}
              widthPct={100}
              colorClass="bg-status-critical/60"
            />
            <Stage
              label="Attempted"
              detail={`${((data.attemptedAmount / data.totalFailedAmount) * 100 || 0).toFixed(0)}% of total failed revenue — the rest was deliberately never pursued (low score, or a guardrail blocked it).`}
              amount={data.attemptedAmount}
              count={data.attemptedCount}
              widthPct={data.totalFailedAmount > 0 ? (data.attemptedAmount / data.totalFailedAmount) * 100 : 0}
              colorClass="bg-status-warning/70"
            />
            <Stage
              label="Recovered"
              detail={
                data.attemptedAmount > 0
                  ? `${((data.recoveredAmount / data.attemptedAmount) * 100).toFixed(1)}% of attempted revenue — this is the real recovery rate.`
                  : "No attempts resolved yet."
              }
              amount={data.recoveredAmount}
              count={data.recoveredCount}
              widthPct={data.totalFailedAmount > 0 ? (data.recoveredAmount / data.totalFailedAmount) * 100 : 0}
              colorClass="bg-status-good"
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
