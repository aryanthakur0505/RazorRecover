"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PlanTable } from "@/components/plans/PlanTable";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/shared/States";
import { LoadMoreFooter } from "@/components/shared/LoadMoreFooter";
import { usePlans } from "@/hooks/usePlans";
import { InstallmentPlanStatus } from "@/lib/types";
import { CalendarClock } from "lucide-react";

const TABS: { value: InstallmentPlanStatus | "ALL"; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "OFFERED", label: "Awaiting Choice" },
  { value: "ACTIVE", label: "Active" },
  { value: "COMPLETED", label: "Completed" },
  { value: "DEFAULTED", label: "Defaulted" },
  { value: "EXPIRED", label: "Expired" },
  { value: "CANCELLED", label: "Cancelled" },
];

export default function PlansPage() {
  const [status, setStatus] = useState<InstallmentPlanStatus | "ALL">("ALL");
  const { plans, total, hasMore, loadMore, isLoading, isLoadingMore, error, mutate } = usePlans(status);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">EMI &amp; Promise Plans</h1>
        <p className="text-sm text-muted-foreground">
          Every INSUFFICIENT_FUNDS payment offered a 6/12/24-month EMI, and every one-off promise
          made on an escalation call — tracked here from offer, to the customer&apos;s choice, to
          month-by-month payment.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Plans</CardTitle>
          <CardDescription>A promise to pay is just a plan with a single installment and no interest.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs value={status} onValueChange={(v) => setStatus(v as InstallmentPlanStatus | "ALL")}>
            <TabsList>
              {TABS.map((t) => (
                <TabsTrigger key={t.value} value={t.value}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {error ? (
            <ErrorState title="Couldn't load plans" description={error.message} onRetry={() => mutate()} />
          ) : isLoading ? (
            <TableSkeleton rows={6} />
          ) : plans.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="No plans here yet"
              description="Offer an EMI plan on a qualifying INSUFFICIENT_FUNDS payment, or log a promise on an escalated one, from Recovery Operations."
            />
          ) : (
            <>
              <PlanTable plans={plans} />
              <LoadMoreFooter shown={plans.length} total={total} hasMore={hasMore} loading={isLoadingMore} onLoadMore={loadMore} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
