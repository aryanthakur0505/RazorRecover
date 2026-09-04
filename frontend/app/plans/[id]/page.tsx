"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ErrorState, CardSkeleton, TableSkeleton } from "@/components/shared/States";
import { PlanStatusBadge } from "@/components/plans/PlanStatusBadge";
import { MetricCard } from "@/components/dashboard/MetricCard";
import { usePlanDetail } from "@/hooks/usePlans";
import { api, ApiError } from "@/lib/api";
import { formatCurrency, formatDate, categoryLabel } from "@/lib/format";
import { ArrowLeft, Wallet, Percent, CalendarClock, CheckCircle2, XCircle, Loader2, MailQuestion, Link as LinkIcon } from "lucide-react";

// Mirrors backend emiService.computeEmiPlan — flat interest, same rate across every tenure. Used
// only to preview what each option would cost while an offer is still awaiting the customer's
// choice; the real numbers are computed server-side once they pick one.
function previewEmi(principalAmount: number, tenureMonths: number, annualInterestRateBps: number) {
  const totalInterest = Math.round((principalAmount * annualInterestRateBps * tenureMonths) / (10_000 * 12));
  const totalPayable = principalAmount + totalInterest;
  return { totalInterest, totalPayable, monthlyAmount: Math.floor(totalPayable / tenureMonths) };
}

export default function PlanDetailPage() {
  const params = useParams<{ id: string }>();
  const { data, error, isLoading, mutate } = usePlanDetail(params.id ?? null);
  const [actingOn, setActingOn] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [resolving, setResolving] = useState(false);

  const plan = data?.plan;
  const isPromise = plan ? plan.tenureMonths === 1 : false;
  const isOffer = plan?.status === "OFFERED";

  async function mark(installmentNumber: number, status: "PAID" | "MISSED") {
    if (!plan) return;
    setActingOn(installmentNumber);
    try {
      await api.post(`/api/installment-plans/${plan.id}/installments/${installmentNumber}/mark`, { status });
      toast.success(status === "PAID" ? "Marked as paid." : "Marked as missed.");
      await mutate();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update this installment.");
    } finally {
      setActingOn(null);
    }
  }

  async function cancelPlan() {
    if (!plan) return;
    setCancelling(true);
    try {
      await api.post(`/api/installment-plans/${plan.id}/cancel`, {});
      toast.success(isOffer ? "Offer withdrawn." : "Plan cancelled.");
      await mutate();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not cancel this plan.");
    } finally {
      setCancelling(false);
    }
  }

  function customerOfferUrl() {
    return `${window.location.origin}/offer/${plan?.id}`;
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(customerOfferUrl());
      toast.success("Link copied — this is what the customer would actually open and click.");
    } catch {
      toast.error("Couldn't copy — your browser may be blocking clipboard access.");
    }
  }

  async function resolveNow() {
    if (!plan) return;
    setResolving(true);
    try {
      const res = await api.post<{ plan: { status: string } }>(`/api/installment-plans/${plan.id}/offer/resolve-now`, {});
      toast.success(
        res.plan.status === "EXPIRED" ? "Customer didn't respond — offer expired." : "Customer accepted the offer.",
      );
      await mutate();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not resolve this offer.");
    } finally {
      setResolving(false);
    }
  }

  return (
    <div className="space-y-6">
      <Link href="/plans" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        Back to EMI &amp; Promise Plans
      </Link>

      {error ? (
        <ErrorState title="Couldn't load this plan" description={error.message} onRetry={() => mutate()} />
      ) : isLoading || !plan ? (
        <div className="space-y-4">
          <CardSkeleton />
          <TableSkeleton rows={5} />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
                <CalendarClock className="size-5 text-muted-foreground" />
                {plan.tenureMonths === null ? "EMI Offer" : isPromise ? "Promise to Pay" : `${plan.tenureMonths}-month EMI Plan`}
              </h1>
              <p className="text-sm text-muted-foreground">
                <Link href={`/customers/${plan.customer.id}`} className="hover:underline">
                  {plan.customer.name}
                </Link>{" "}
                · {plan.customer.email} · originally {categoryLabel(plan.payment.failureCategory)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <PlanStatusBadge status={plan.status} />
              {isOffer && (
                <>
                  <Button variant="outline" size="sm" onClick={copyLink}>
                    <LinkIcon className="size-4" />
                    Copy Customer Link
                  </Button>
                  <Button variant="outline" size="sm" disabled={resolving} onClick={resolveNow}>
                    {resolving ? <Loader2 className="size-4 animate-spin" /> : null}
                    Resolve Now
                  </Button>
                  <Button variant="outline" size="sm" disabled={cancelling} onClick={cancelPlan}>
                    {cancelling ? <Loader2 className="size-4 animate-spin" /> : null}
                    Withdraw Offer
                  </Button>
                </>
              )}
              {plan.status === "ACTIVE" && (
                <Button variant="outline" size="sm" disabled={cancelling} onClick={cancelPlan}>
                  {cancelling ? <Loader2 className="size-4 animate-spin" /> : null}
                  Cancel Plan
                </Button>
              )}
            </div>
          </div>

          {isOffer ? (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <MetricCard label="Amount Owed" value={formatCurrency(plan.principalAmount)} icon={Wallet} />
                <MetricCard
                  label="Interest Rate"
                  value={`${(plan.annualInterestRateBps / 100).toFixed(1)}% p.a.`}
                  subLabel="flat, same across every tenure"
                  icon={Percent}
                />
                <MetricCard
                  label="Offer Expires"
                  value={plan.offerExpiresAt ? formatDate(plan.offerExpiresAt) : "—"}
                  icon={MailQuestion}
                />
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Waiting on the Customer</CardTitle>
                  <CardDescription className="space-y-1">
                    <span className="block">
                      The customer was offered these three options and hasn&apos;t picked one yet. Whichever they
                      choose becomes the real plan — nothing is collected until then.
                    </span>
                    <span className="block font-mono text-xs">
                      {typeof window !== "undefined" ? customerOfferUrl() : ""}
                    </span>
                    <span className="block">
                      Open that link yourself to make a real choice, or use &quot;Resolve Now&quot; to simulate them
                      responding immediately instead of waiting for the window to close.
                    </span>
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Tenure</TableHead>
                          <TableHead>Monthly</TableHead>
                          <TableHead>Total Interest</TableHead>
                          <TableHead>Total Payable</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {[6, 12, 24].map((months) => {
                          const preview = previewEmi(plan.principalAmount, months, plan.annualInterestRateBps);
                          return (
                            <TableRow key={months}>
                              <TableCell className="font-medium">{months} months</TableCell>
                              <TableCell>{formatCurrency(preview.monthlyAmount)}</TableCell>
                              <TableCell className="text-muted-foreground">{formatCurrency(preview.totalInterest)}</TableCell>
                              <TableCell>{formatCurrency(preview.totalPayable)}</TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </>
          ) : plan.status === "EXPIRED" ? (
            <Card>
              <CardHeader>
                <CardTitle>Offer Expired</CardTitle>
                <CardDescription>
                  The customer never responded within the window. This payment has reverted to the normal
                  recovery pipeline and can be picked up again in a future cycle.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard label="Principal" value={formatCurrency(plan.principalAmount)} icon={Wallet} />
                {!isPromise && (
                  <MetricCard
                    label="Interest"
                    value={formatCurrency(plan.totalInterest ?? 0)}
                    subLabel={`${(plan.annualInterestRateBps / 100).toFixed(1)}% p.a. flat`}
                    icon={Percent}
                  />
                )}
                <MetricCard
                  label={isPromise ? "Amount Due" : "Total Payable"}
                  value={formatCurrency(plan.totalPayable ?? plan.principalAmount)}
                  icon={Wallet}
                  tone={isPromise ? undefined : "good"}
                />
                <MetricCard
                  label={isPromise ? "Due Date" : "Monthly Amount"}
                  value={
                    isPromise
                      ? formatDate(plan.installments[0]?.dueDate ?? plan.startDate)
                      : formatCurrency(plan.monthlyAmount ?? 0)
                  }
                  icon={CalendarClock}
                />
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>{isPromise ? "The Promise" : "Month-by-Month"}</CardTitle>
                  <CardDescription>
                    {plan.status === "ACTIVE"
                      ? "Mark an installment manually if a real payment came in outside the simulated model."
                      : "This plan is closed — no further updates."}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{isPromise ? "" : "#"}</TableHead>
                          <TableHead>Due Date</TableHead>
                          <TableHead>Amount</TableHead>
                          <TableHead>Status</TableHead>
                          {plan.status === "ACTIVE" && <TableHead />}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {plan.installments.map((i) => (
                          <TableRow key={i.id}>
                            <TableCell className="text-muted-foreground">{isPromise ? "—" : i.installmentNumber}</TableCell>
                            <TableCell>{formatDate(i.dueDate)}</TableCell>
                            <TableCell>{formatCurrency(i.amount)}</TableCell>
                            <TableCell>
                              {i.status === "PAID" ? (
                                <Badge variant="outline" className="gap-1 border-transparent bg-status-good/15 text-success-text">
                                  <CheckCircle2 className="size-3" />
                                  Paid
                                </Badge>
                              ) : i.status === "MISSED" ? (
                                <Badge variant="outline" className="gap-1 border-transparent bg-status-critical/15 text-status-critical">
                                  <XCircle className="size-3" />
                                  Missed
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="gap-1 border-transparent bg-muted text-muted-foreground">
                                  Pending
                                </Badge>
                              )}
                            </TableCell>
                            {plan.status === "ACTIVE" && (
                              <TableCell>
                                {i.status === "PENDING" && (
                                  <div className="flex gap-2">
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      disabled={actingOn === i.installmentNumber}
                                      onClick={() => mark(i.installmentNumber, "PAID")}
                                    >
                                      {actingOn === i.installmentNumber ? <Loader2 className="size-4 animate-spin" /> : null}
                                      Mark Paid
                                    </Button>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      disabled={actingOn === i.installmentNumber}
                                      onClick={() => mark(i.installmentNumber, "MISSED")}
                                    >
                                      Mark Missed
                                    </Button>
                                  </div>
                                )}
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}
