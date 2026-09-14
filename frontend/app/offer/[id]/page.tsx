"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { toast } from "sonner";
import { motion } from "motion/react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CardSkeleton, ErrorState } from "@/components/shared/States";
import { api, ApiError } from "@/lib/api";
import { formatCurrency, formatDate } from "@/lib/format";
import { ShieldHalf, CheckCircle2, Percent } from "lucide-react";

interface TenureOption {
  tenureMonths: 6 | 12 | 24;
  totalInterest: number;
  totalPayable: number;
  monthlyAmount: number;
}

interface OfferResponse {
  id: string;
  status: "OFFERED" | "ACTIVE" | "COMPLETED" | "DEFAULTED" | "EXPIRED" | "CANCELLED";
  customerName: string;
  principalAmount: number;
  annualInterestRateBps: number;
  offerExpiresAt: string | null;
  chosenTenureMonths: number | null;
  options: TenureOption[];
}

const STATUS_MESSAGE: Record<Exclude<OfferResponse["status"], "OFFERED">, string> = {
  ACTIVE: "You've already chosen a plan for this — nothing more to do here.",
  COMPLETED: "This plan is already fully paid off. Nothing more to do here.",
  DEFAULTED: "This plan is no longer open.",
  EXPIRED: "This offer window has closed.",
  CANCELLED: "This offer was withdrawn by the merchant.",
};

/**
 * The real customer-facing page — no login, no merchant nav (see AppShell), reached only via the
 * link the merchant sends. A genuine click here activates the plan directly (emiService.
 * chooseOfferTenure), no simulated dice roll standing in for the customer.
 */
export default function CustomerOfferPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { data, error, isLoading, mutate } = useSWR<OfferResponse>(id ? `/api/public/emi-offers/${id}` : null, {
    revalidateOnFocus: false,
  });
  const [choosing, setChoosing] = useState<number | null>(null);
  const [chosen, setChosen] = useState<{ tenureMonths: number; monthlyAmount: number } | null>(null);

  // A page title that doesn't leak into the merchant's own tab context.
  useEffect(() => {
    document.title = "Choose Your Payment Plan";
  }, []);

  async function choose(tenureMonths: 6 | 12 | 24) {
    if (!id) return;
    setChoosing(tenureMonths);
    try {
      const res = await api.post<{ plan: { tenureMonths: number; monthlyAmount: number } }>(
        `/api/public/emi-offers/${id}/choose`,
        { tenureMonths },
      );
      setChosen(res.plan);
      await mutate();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not record your choice — please try again.");
    } finally {
      setChoosing(null);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,var(--chart-1)_0%,transparent_45%)] bg-muted/30 px-4 py-10">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="w-full max-w-lg space-y-4"
      >
        <div className="flex items-center justify-center gap-2 text-sm font-medium text-muted-foreground">
          <ShieldHalf className="size-4 text-chart-1" />
          <span className="font-heading">RazorRecover Payment Options</span>
        </div>

        {error ? (
          <ErrorState
            title="Couldn't load this offer"
            description={error instanceof ApiError ? error.message : "Something went wrong."}
            onRetry={() => mutate()}
          />
        ) : isLoading || !data ? (
          <CardSkeleton />
        ) : chosen ? (
          <Card>
            <CardHeader className="items-center text-center">
              <CheckCircle2 className="size-10 text-status-good" />
              <CardTitle>You&apos;re all set</CardTitle>
              <CardDescription>
                {chosen.tenureMonths}-month plan confirmed — {formatCurrency(chosen.monthlyAmount)} per month.
                You&apos;ll get a payment link each month when it&apos;s due.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : data.status !== "OFFERED" ? (
          <Card>
            <CardHeader className="items-center text-center">
              <CardTitle>Hi {data.customerName}</CardTitle>
              <CardDescription>{STATUS_MESSAGE[data.status]}</CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Hi {data.customerName}</CardTitle>
                <CardDescription>
                  You have a pending payment of {formatCurrency(data.principalAmount)}. Choose how you&apos;d like to
                  pay it off instead of all at once
                  {data.offerExpiresAt && <> — this offer is open until {formatDate(data.offerExpiresAt)}</>}.
                </CardDescription>
              </CardHeader>
            </Card>

            <div className="space-y-3">
              {data.options.map((opt, i) => (
                <motion.div
                  key={opt.tenureMonths}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, delay: i * 0.06 }}
                >
                  <Card className="transition-shadow hover:shadow-md">
                    <CardContent className="flex items-center justify-between gap-4 py-4">
                      <div>
                        <p className="font-heading text-lg font-semibold">{opt.tenureMonths} months</p>
                        <p className="text-sm text-muted-foreground">
                          {formatCurrency(opt.monthlyAmount)}/mo · {formatCurrency(opt.totalInterest)} total interest
                        </p>
                        <p className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Percent className="size-3" />
                          {(data.annualInterestRateBps / 100).toFixed(1)}% p.a. flat · pay {formatCurrency(opt.totalPayable)} in total
                        </p>
                      </div>
                      <Button onClick={() => choose(opt.tenureMonths)} disabled={choosing !== null}>
                        {choosing === opt.tenureMonths ? "Choosing…" : "Choose this plan"}
                      </Button>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </div>
          </>
        )}
      </motion.div>
    </div>
  );
}
