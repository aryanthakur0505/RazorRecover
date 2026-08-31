"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState, CardSkeleton } from "@/components/shared/States";
import { useAIComparison } from "@/hooks/useDashboard";
import { formatCurrency, formatPercent, actionLabel } from "@/lib/format";
import { Sparkles, ArrowRight, Target } from "lucide-react";
import { cn } from "@/lib/utils";

function Stat({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "good" | "critical" }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "font-mono text-xl font-semibold tabular-nums",
          tone === "good" && "text-success-text",
          tone === "critical" && "text-status-critical",
        )}
      >
        {value}
      </p>
    </div>
  );
}

export function AIImpactCard() {
  const { data, error, isLoading, mutate } = useAIComparison();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-chart-1" />
          AI Impact — Shadow Mode
        </CardTitle>
        <CardDescription>
          Every AI-assisted decision is compared against what the deterministic engine alone would
          have decided on the same case — never acted on, just measured — so this answers whether
          the AI is actually adding value instead of just assuming it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error ? (
          <ErrorState title="Couldn't load AI comparison" description={error.message} onRetry={() => mutate()} />
        ) : isLoading || !data ? (
          <CardSkeleton />
        ) : data.totalAIAssisted === 0 ? (
          <EmptyState
            icon={Sparkles}
            title="No AI-assisted decisions yet"
            description="This fills in once an ambiguous payment (an unclear failure reason, a mid-range recovery score, or conflicting signals) gets escalated to the AI reasoning agent."
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              <Stat label="AI-Assisted Decisions" value={data.totalAIAssisted.toLocaleString()} />
              <Stat label="Agreed with Engine" value={formatPercent(data.agreementRate)} />
              <Stat
                label="Revenue AI Found"
                value={formatCurrency(data.revenueFoundByAI)}
                tone={data.revenueFoundByAI > 0 ? "good" : "neutral"}
              />
              <Stat label="Disagreements Resolved" value={data.resolvedDisagreements.toLocaleString()} />
              <Stat
                label="Est. Incremental Net"
                value={formatCurrency(data.estimatedIncrementalNet)}
                tone={data.estimatedIncrementalNet >= 0 ? "good" : "critical"}
              />
            </div>

            <p className="text-xs text-muted-foreground">
              <strong className="text-foreground">Revenue AI Found</strong> is real, measured
              revenue (not an estimate) from cases where the deterministic engine would have given
              up entirely (Stop) but the AI chose to act anyway, and it paid off — the clearest
              single number for "did the AI add value." <strong className="text-foreground">Est.
              Incremental Net</strong> is the broader picture across every disagreement, including
              cases where both would have acted but chose differently — and since the deterministic
              path is never actually run, that side is necessarily a{" "}
              <strong className="text-foreground">projection</strong>, using the same recovery-score
              probability model the rest of this app already relies on.
            </p>

            {data.disagreedCount === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                The AI has agreed with the deterministic engine on every case so far — nothing to compare yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Customer</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>AI chose</TableHead>
                      <TableHead>Engine would've</TableHead>
                      <TableHead className="hidden sm:table-cell">Actual (AI)</TableHead>
                      <TableHead className="hidden sm:table-cell">Est. (Engine)</TableHead>
                      <TableHead>Delta</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rows
                      .filter((r) => !r.agreed)
                      .map((r) => (
                        <TableRow key={r.attemptId} className={r.engineWouldHaveMissedThis ? "bg-status-good/5" : undefined}>
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-1.5">
                              {r.customerName}
                              {r.engineWouldHaveMissedThis && (
                                <Badge
                                  variant="outline"
                                  className="gap-1 border-status-good/30 bg-status-good/10 text-success-text"
                                >
                                  <Target className="size-3" />
                                  Engine would've missed this
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="tabular-nums">{formatCurrency(r.amount)}</TableCell>
                          <TableCell>
                            <span className="inline-flex items-center gap-1">
                              {actionLabel(r.aiAction)}
                              <span className="text-xs text-muted-foreground">
                                ({(r.aiConfidence * 100).toFixed(0)}%)
                              </span>
                            </span>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <ArrowRight className="size-3" />
                              {actionLabel(r.shadowAction)}
                            </span>
                          </TableCell>
                          <TableCell className="hidden tabular-nums sm:table-cell">
                            {r.actualNetRecovered !== null ? formatCurrency(r.actualNetRecovered) : "pending"}
                          </TableCell>
                          <TableCell className="hidden tabular-nums text-muted-foreground sm:table-cell">
                            {r.estimatedShadowNet !== null ? formatCurrency(r.estimatedShadowNet) : "—"}
                          </TableCell>
                          <TableCell
                            className={cn(
                              "tabular-nums font-medium",
                              r.delta === null
                                ? "text-muted-foreground"
                                : r.delta >= 0
                                  ? "text-success-text"
                                  : "text-status-critical",
                            )}
                          >
                            {r.delta !== null ? formatCurrency(r.delta) : "pending"}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
