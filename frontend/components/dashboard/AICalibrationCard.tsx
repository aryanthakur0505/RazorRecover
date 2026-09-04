"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState, CardSkeleton } from "@/components/shared/States";
import { useAIConfidenceCalibration } from "@/hooks/useDashboard";
import { formatPercent } from "@/lib/format";
import { Gauge } from "lucide-react";
import { cn } from "@/lib/utils";

// Below this many resolved cases in a bucket, an "actual success rate" is just noise dressed up
// as a percentage — flag it rather than let a 1-of-2 look as authoritative as a 20-of-21.
const MIN_TRUSTWORTHY_N = 5;

export function AICalibrationCard() {
  const { data, error, isLoading, mutate } = useAIConfidenceCalibration();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="size-4 text-chart-1" />
          AI Confidence Calibration
        </CardTitle>
        <CardDescription>
          The AI states a 0–1 confidence alongside every recommendation, but nothing requires that
          number to mean anything — the model is only ever told &quot;confidence in this
          recommendation,&quot; with no rubric. This checks it against real outcomes instead of
          assuming a stated 90% actually succeeds more often than a stated 30%.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error ? (
          <ErrorState title="Couldn't load calibration data" description={error.message} onRetry={() => mutate()} />
        ) : isLoading || !data ? (
          <CardSkeleton />
        ) : data.totalResolved === 0 ? (
          <EmptyState
            icon={Gauge}
            title="Nothing resolved to check yet"
            description="This fills in once AI-assisted RETRY/PAYMENT_LINK/ESCALATE attempts (Stop has no outcome to check against) actually succeed or fail."
          />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground">Avg. stated confidence when it succeeded</p>
                <p className="font-mono text-xl font-semibold tabular-nums text-success-text">
                  {data.avgConfidenceWhenSucceeded !== null ? formatPercent(data.avgConfidenceWhenSucceeded) : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Avg. stated confidence when it failed</p>
                <p className="font-mono text-xl font-semibold tabular-nums text-status-critical">
                  {data.avgConfidenceWhenFailed !== null ? formatPercent(data.avgConfidenceWhenFailed) : "—"}
                </p>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              If the AI were well-calibrated, those two numbers would be far apart — a model that
              actually knows what it doesn&apos;t know says so before the fact. Based on{" "}
              {data.totalResolved} resolved case{data.totalResolved === 1 ? "" : "s"} so far, this
              is a small sample — read it as an early signal, not a verdict.
            </p>

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Stated confidence</TableHead>
                    <TableHead>Cases</TableHead>
                    <TableHead>Avg. stated</TableHead>
                    <TableHead>Actual success rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.buckets.map((b) => (
                    <TableRow key={b.label}>
                      <TableCell className="font-medium">{b.label}</TableCell>
                      <TableCell className="tabular-nums">{b.count}</TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {b.avgStatedConfidence !== null ? formatPercent(b.avgStatedConfidence) : "—"}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "tabular-nums font-medium",
                          b.actualSuccessRate === null ? "text-muted-foreground" : "text-foreground",
                        )}
                      >
                        {b.actualSuccessRate !== null ? formatPercent(b.actualSuccessRate) : "—"}
                        {b.count > 0 && b.count < MIN_TRUSTWORTHY_N && (
                          <span className="ml-1.5 text-xs text-muted-foreground">(n={b.count}, too few to trust)</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
