"use client";

import { Fragment, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorState, CardSkeleton, TableSkeleton, EmptyState } from "@/components/shared/States";
import { DoNotContactControl } from "@/components/shared/DoNotContactControl";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { MetricCard } from "@/components/dashboard/MetricCard";
import { CustomerNotes } from "@/components/customers/CustomerNotes";
import { useCustomerProfile } from "@/hooks/useCustomer";
import { formatCurrency, formatDate, formatPercent, actionLabel, categoryLabel } from "@/lib/format";
import { ArrowLeft, Wallet, Receipt, Percent, TrendingUp, Sparkles, User } from "lucide-react";

export default function CustomerProfilePage() {
  const params = useParams<{ id: string }>();
  const { data, error, isLoading, mutate } = useCustomerProfile(params.id ?? null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <Link
        href="/operations"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to Recovery Operations
      </Link>

      {error ? (
        <ErrorState
          title="Couldn't load this customer"
          description={error.message}
          onRetry={() => mutate()}
        />
      ) : isLoading || !data ? (
        <div className="space-y-4">
          <CardSkeleton />
          <TableSkeleton rows={5} />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
                <User className="size-5 text-muted-foreground" />
                {data.customer.name}
              </h1>
              <p className="text-sm text-muted-foreground">
                {data.customer.email} · Customer since {formatDate(data.stats.customerSince)}
                {data.customer.isSimulated && " · Simulated"}
              </p>
            </div>
            <DoNotContactControl customer={data.customer} onMutated={() => mutate()} />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label="Lifetime Value"
              value={formatCurrency(data.stats.lifetimeValue)}
              subLabel={`${data.stats.successfulPayments} of ${data.stats.totalPayments} payments succeeded outright`}
              icon={Wallet}
              tone="good"
            />
            <MetricCard
              label="Revenue Recovered"
              value={formatCurrency(data.stats.revenueRecovered)}
              subLabel={`${data.stats.successfulRecoveries} ${data.stats.successfulRecoveries === 1 ? "recovery" : "recoveries"}`}
              icon={TrendingUp}
              tone="good"
            />
            <MetricCard
              label="Recovery Rate"
              value={data.stats.recoveryRate !== null ? formatPercent(data.stats.recoveryRate) : "—"}
              subLabel={`${data.stats.successfulRecoveries}/${data.stats.totalRecoveryAttempts} attempts`}
              icon={Percent}
            />
            <MetricCard
              label="Failed Payments"
              value={data.stats.failedPayments.toLocaleString()}
              subLabel="currently unresolved"
              icon={Receipt}
              tone={data.stats.failedPayments > 0 ? "warning" : "neutral"}
            />
          </div>

          <CustomerNotes customerId={data.customer.id} notes={data.notes} onAdded={() => mutate()} />

          <Card>
            <CardHeader>
              <CardTitle>Payment History</CardTitle>
            </CardHeader>
            <CardContent>
              {data.payments.length === 0 ? (
                <EmptyState title="No payments yet" description="This customer has no payment history." />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Amount</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="hidden sm:table-cell">Failure</TableHead>
                        <TableHead className="hidden md:table-cell">Score</TableHead>
                        <TableHead>Attempts</TableHead>
                        <TableHead>Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.payments.map((p) => (
                        <Fragment key={p.id}>
                          <TableRow
                            className={p.attempts.length > 0 ? "cursor-pointer" : undefined}
                            onClick={() => p.attempts.length > 0 && toggleExpand(p.id)}
                          >
                            <TableCell className="tabular-nums">{formatCurrency(p.amount)}</TableCell>
                            <TableCell>
                              <StatusBadge status={p.status} />
                            </TableCell>
                            <TableCell className="hidden sm:table-cell">{categoryLabel(p.failureCategory)}</TableCell>
                            <TableCell className="hidden font-mono tabular-nums md:table-cell">
                              {p.recoveryScore ?? "—"}
                            </TableCell>
                            <TableCell className="tabular-nums">{p.attempts.length || "—"}</TableCell>
                            <TableCell className="text-muted-foreground">{formatDate(p.createdAt)}</TableCell>
                          </TableRow>
                          {expanded.has(p.id) &&
                            p.attempts.map((a) => (
                              <TableRow key={a.id} className="bg-muted/30 hover:bg-muted/30">
                                <TableCell colSpan={6} className="py-2 pl-8 text-sm text-muted-foreground">
                                  <span className="inline-flex items-center gap-1.5">
                                    Attempt #{a.attemptNumber}: <span className="text-foreground">{actionLabel(a.action)}</span>
                                    {a.usedAI && <Sparkles className="size-3 text-chart-1" aria-label="AI-assisted" />}
                                    <StatusBadge status={a.status} />
                                    {a.netRecovered !== null && (
                                      <span className="tabular-nums">Net {formatCurrency(a.netRecovered)}</span>
                                    )}
                                    <span>· {formatDate(a.createdAt)}</span>
                                  </span>
                                </TableCell>
                              </TableRow>
                            ))}
                        </Fragment>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
