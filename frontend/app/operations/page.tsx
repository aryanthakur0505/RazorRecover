"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OpportunityTable } from "@/components/operations/OpportunityTable";
import { DecisionDrawer } from "@/components/operations/DecisionDrawer";
import { ErrorState, TableSkeleton } from "@/components/shared/States";
import { useOpportunities } from "@/hooks/useOpportunities";

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
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data, error, isLoading, mutate } = useOpportunities(filter || undefined);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Recovery Operations</h1>
        <p className="text-sm text-muted-foreground">
          Every recovery opportunity, its explanation, and the guardrails applied — approve, reject, or execute.
        </p>
      </div>

      <Tabs value={filter} onValueChange={setFilter}>
        <TabsList className="flex h-auto flex-wrap justify-start gap-1 bg-transparent p-0">
          {FILTERS.map((f) => (
            <TabsTrigger key={f.value} value={f.value} className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              {f.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Card>
        <CardContent className="pt-6">
          {error ? (
            <ErrorState title="Couldn't load recovery opportunities" description={error.message} onRetry={() => mutate()} />
          ) : isLoading || !data ? (
            <TableSkeleton rows={6} />
          ) : (
            <OpportunityTable attempts={data.attempts} onSelect={setSelectedId} />
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
