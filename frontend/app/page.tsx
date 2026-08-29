"use client";

import { useDashboardMetrics, useCharts, useRecentActivity } from "@/hooks/useDashboard";
import { MetricCard } from "@/components/dashboard/MetricCard";
import { AgentStatusCard } from "@/components/dashboard/AgentStatusCard";
import { RevenueChart } from "@/components/dashboard/RevenueChart";
import { BreakdownBarChart } from "@/components/dashboard/BreakdownBarChart";
import { OutcomeSplit } from "@/components/dashboard/OutcomeSplit";
import { RecentActivityTable } from "@/components/dashboard/RecentActivityTable";
import { SimulationPanel } from "@/components/dashboard/SimulationPanel";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { CardSkeleton, ErrorState, TableSkeleton } from "@/components/shared/States";
import { formatCurrency, formatPercent, categoryLabel, actionLabel } from "@/lib/format";
import {
  AlertTriangle,
  TrendingUp,
  PiggyBank,
  Percent,
  Wallet,
  LineChart as LineChartIcon,
  Receipt,
} from "lucide-react";

export default function CommandCenterPage() {
  const { data: metrics, error: metricsError, isLoading: metricsLoading, mutate: mutateMetrics } = useDashboardMetrics();
  const { data: charts, isLoading: chartsLoading } = useCharts();
  const { data: activity, isLoading: activityLoading } = useRecentActivity();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Executive Command Center</h1>
        <p className="text-sm text-muted-foreground">
          Live revenue-recovery performance across every failed and at-risk payment.
        </p>
      </div>

      {metricsError ? (
        <ErrorState
          title="Couldn't load dashboard metrics"
          description={metricsError.message}
          onRetry={() => mutateMetrics()}
        />
      ) : metricsLoading || !metrics ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <MetricCard
              label="Payments Processed"
              value={metrics.totalPayments.toLocaleString()}
              subLabel={`${metrics.successfulPayments.toLocaleString()} succeeded (${formatPercent(metrics.baselineSuccessRate)} baseline)`}
              icon={Receipt}
            />
            <MetricCard label="Revenue at Risk" value={formatCurrency(metrics.revenueAtRisk)} icon={AlertTriangle} tone="warning" />
            <MetricCard label="Revenue Recovered" value={formatCurrency(metrics.revenueRecovered)} icon={TrendingUp} tone="good" />
            <MetricCard label="Net Recovered Revenue" value={formatCurrency(metrics.netRecoveredRevenue)} icon={PiggyBank} tone="good" />
            <MetricCard label="Recovery Rate" value={formatPercent(metrics.recoveryRate)} icon={Percent} />
            <MetricCard label="Recovery Cost" value={formatCurrency(metrics.recoveryCost)} icon={Wallet} />
            <MetricCard
              label="Net ROI"
              value={metrics.netROI >= 0 ? `${metrics.netROI.toFixed(1)}x` : "—"}
              subLabel={`${metrics.pendingApprovals} pending approval${metrics.pendingApprovals === 1 ? "" : "s"}`}
              icon={LineChartIcon}
              tone={metrics.netROI >= 0 ? "good" : "critical"}
            />
          </div>
          <AgentStatusCard status={metrics.agentStatus} />
        </>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Revenue Recovered vs Cost Over Time</CardTitle>
          </CardHeader>
          <CardContent>
            {chartsLoading || !charts ? <TableSkeleton rows={4} /> : <RevenueChart data={charts.revenueOverTime} />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recovery Attempt Outcomes</CardTitle>
            <CardDescription>Of the payments that needed recovery, how many were won back</CardDescription>
          </CardHeader>
          <CardContent>
            {chartsLoading || !charts ? (
              <TableSkeleton rows={3} />
            ) : (
              <OutcomeSplit succeeded={charts.outcomeBreakdown.succeeded} failed={charts.outcomeBreakdown.failed} />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recovery by Failure Type</CardTitle>
          </CardHeader>
          <CardContent>
            {chartsLoading || !charts ? (
              <TableSkeleton rows={4} />
            ) : (
              <BreakdownBarChart
                emptyTitle="No failed payments yet"
                data={charts.byFailureType.map((c) => ({ label: categoryLabel(c.category), count: c.count }))}
              />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recovery by Action</CardTitle>
          </CardHeader>
          <CardContent>
            {chartsLoading || !charts ? (
              <TableSkeleton rows={4} />
            ) : (
              <BreakdownBarChart
                emptyTitle="No recovery attempts yet"
                data={charts.byAction.map((c) => ({ label: actionLabel(c.action), count: c.count }))}
              />
            )}
          </CardContent>
        </Card>
      </div>

      <SimulationPanel />

      <Card>
        <CardHeader>
          <CardTitle>Recent Recovery Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {activityLoading || !activity ? <TableSkeleton /> : <RecentActivityTable attempts={activity.attempts} />}
        </CardContent>
      </Card>
    </div>
  );
}
