"use client";

import { useEffect, useState } from "react";
import { useSWRConfig } from "swr";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSimulation } from "@/hooks/useSimulation";
import { formatCurrency, formatPercent } from "@/lib/format";
import { PlayCircle, Sparkles } from "lucide-react";

const SIZES = [100, 500, 1000] as const;

export function SimulationPanel() {
  const [size, setSize] = useState<(typeof SIZES)[number]>(100);
  const { job, error, run } = useSimulation();
  const { mutate } = useSWRConfig();

  const running = job?.status === "RUNNING";

  useEffect(() => {
    if (job?.status === "COMPLETED") {
      mutate("/api/metrics/dashboard");
      mutate("/api/metrics/charts");
      mutate("/api/metrics/recent-activity");
      mutate((key) => typeof key === "string" && key.startsWith("/api/recovery/opportunities"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-chart-1" />
          Run a Simulation
        </CardTitle>
        <CardDescription>
          Generates a seeded synthetic dataset and runs it through the exact same recovery engine, policies, and guardrails as live traffic.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select value={String(size)} onValueChange={(v) => setSize(Number(v) as (typeof SIZES)[number])} disabled={running}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SIZES.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s.toLocaleString()} payments
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => run(size)} disabled={running}>
            <PlayCircle className="size-4" />
            {running ? "Simulating…" : "Run Simulation"}
          </Button>
        </div>

        {error && <p className="text-sm text-status-critical">{error}</p>}

        {job && (
          <div className="space-y-3">
            {running && (
              <div className="space-y-1.5">
                <Progress value={(job.processed / job.total) * 100} />
                <p className="text-xs text-muted-foreground">
                  Processed {job.processed.toLocaleString()} / {job.total.toLocaleString()} synthetic payments…
                </p>
              </div>
            )}

            {job.status === "FAILED" && <p className="text-sm text-status-critical">{job.error ?? "Simulation failed."}</p>}

            {job.status === "COMPLETED" && job.result && (
              <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/40 p-4 sm:grid-cols-4">
                <Stat label="Analyzed" value={job.result.paymentsAnalyzed.toLocaleString()} />
                <Stat label="Failed" value={job.result.failedPayments.toLocaleString()} />
                <Stat label="Recovery Attempts" value={job.result.recoveryAttemptsExecuted.toLocaleString()} />
                <Stat label="Recovered" value={job.result.successfulRecoveries.toLocaleString()} />
                <Stat label="Revenue at Risk" value={formatCurrency(job.result.revenueAtRisk)} />
                <Stat label="Revenue Recovered" value={formatCurrency(job.result.revenueRecovered)} />
                <Stat label="Net Recovered" value={formatCurrency(job.result.netRecoveredRevenue)} />
                <Stat label="Recovery Rate" value={formatPercent(job.result.recoveryRate)} />
              </div>
            )}

            {job.status === "COMPLETED" && job.result && (
              <p className="text-xs text-muted-foreground">
                {job.result.aiEscalatedCount > 0 ? (
                  <>
                    <Sparkles className="mr-1 inline size-3 text-chart-1" />
                    {job.result.aiEscalatedCount} genuinely ambiguous payment{job.result.aiEscalatedCount === 1 ? "" : "s"} in
                    this run made a real AI call — see AI Impact on this dashboard.
                  </>
                ) : (
                  "No payment in this run was ambiguous enough to escalate to AI."
                )}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-mono text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}
