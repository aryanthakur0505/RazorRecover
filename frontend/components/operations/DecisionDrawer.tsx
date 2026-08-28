"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { RiskFlagBadges } from "@/components/operations/RiskFlagBadges";
import { useOpportunity } from "@/hooks/useOpportunities";
import { api, ApiError } from "@/lib/api";
import { formatCurrency, formatDate, actionLabel, categoryLabel } from "@/lib/format";
import { CheckCircle2, XCircle, PlayCircle, Sparkles, Loader2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export function DecisionDrawer({
  attemptId,
  onOpenChange,
  onMutated,
}: {
  attemptId: string | null;
  onOpenChange: (open: boolean) => void;
  onMutated: () => void;
}) {
  const { data, mutate, isLoading } = useOpportunity(attemptId);
  const [busy, setBusy] = useState(false);
  const attempt = data?.attempt;

  async function act(action: "approve" | "reject" | "execute") {
    if (!attemptId) return;
    setBusy(true);
    try {
      await api.post(`/api/recovery/${attemptId}/${action}`);
      toast.success(
        action === "approve" ? "Approved — sending to Razorpay." : action === "reject" ? "Rejected." : "Execution triggered.",
      );
      await mutate();
      onMutated();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={!!attemptId} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Recovery Decision</SheetTitle>
          <SheetDescription>Full explanation, guardrail checks, and available actions.</SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-4 pb-6">
          {isLoading || !attempt ? (
            <div className="space-y-3">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : (
            <>
              <section className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{attempt.payment.customer.name}</p>
                  <StatusBadge status={attempt.status} />
                </div>
                <p className="text-2xl font-semibold tabular-nums">{formatCurrency(attempt.payment.amount)}</p>
                <p className="text-sm text-muted-foreground">
                  {categoryLabel(attempt.payment.failureCategory)} · Attempt #{attempt.attemptNumber} · {formatDate(attempt.createdAt)}
                </p>
              </section>

              <Separator />

              <section className="space-y-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  Recommended Action
                  {attempt.usedAI && (
                    <span className="inline-flex items-center gap-1 text-xs font-normal text-chart-1">
                      <Sparkles className="size-3.5" /> AI-assisted
                    </span>
                  )}
                </h3>
                <p className="text-sm">
                  <span className="font-medium">{actionLabel(attempt.action)}</span>
                  {attempt.aiOutput && ` — ${attempt.aiOutput.cause}`}
                </p>
                {attempt.aiOutput && (
                  <p className="text-xs text-muted-foreground">
                    Confidence: {(attempt.aiOutput.confidence_score * 100).toFixed(0)}%
                  </p>
                )}
              </section>

              <Separator />

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Recovery Score: {attempt.payment.recoveryScore ?? "—"}</h3>
                <ul className="space-y-1.5">
                  {(attempt.decisionFactors ?? []).map((f, i) => (
                    <li key={i} className="flex items-start justify-between gap-2 text-sm">
                      <span className="text-muted-foreground">{f.detail}</span>
                      {"impact" in f && typeof f.impact === "number" && (
                        <span className={`shrink-0 tabular-nums ${f.impact >= 0 ? "text-success-text" : "text-status-critical"}`}>
                          {f.impact >= 0 ? "+" : ""}
                          {f.impact}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>

              <Separator />

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Risk Flags</h3>
                <RiskFlagBadges flags={attempt.riskFlags} />
              </section>

              {attempt.policyChecks && attempt.policyChecks.length > 0 && (
                <>
                  <Separator />
                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold">Policy & Guardrail Checks</h3>
                    <ul className="space-y-1.5">
                      {attempt.policyChecks.map((c, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm">
                          {c.passed ? (
                            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-text" />
                          ) : (
                            <XCircle className="mt-0.5 size-4 shrink-0 text-status-critical" />
                          )}
                          <span className="text-muted-foreground">{c.detail}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                </>
              )}

              {(attempt.revenueRecovered !== null || attempt.recoveryCost !== null) && (
                <>
                  <Separator />
                  <section className="grid grid-cols-3 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">Recovered</p>
                      <p className="font-mono tabular-nums">{formatCurrency(attempt.revenueRecovered ?? 0)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Cost</p>
                      <p className="font-mono tabular-nums">{formatCurrency(attempt.recoveryCost ?? 0)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Net</p>
                      <p className="font-mono tabular-nums">{formatCurrency(attempt.netRecovered ?? 0)}</p>
                    </div>
                  </section>
                </>
              )}
            </>
          )}
        </div>

        {attempt && (
          <SheetFooter className="flex-row gap-2">
            {attempt.status === "AWAITING_APPROVAL" ? (
              <>
                <Button variant="outline" className="flex-1" disabled={busy} onClick={() => act("reject")}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <XCircle className="size-4" />}
                  Reject
                </Button>
                <Button className="flex-1" disabled={busy} onClick={() => act("approve")}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                  Approve
                </Button>
              </>
            ) : attempt.status === "PENDING" ? (
              <Button className="flex-1" disabled={busy} onClick={() => act("execute")}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <PlayCircle className="size-4" />}
                Execute Now
              </Button>
            ) : (
              <p className="w-full text-center text-sm text-muted-foreground">
                This attempt is {attempt.status.toLowerCase().replace(/_/g, " ")} — no further action available.
              </p>
            )}
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
