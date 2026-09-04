import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { PlanStatusBadge } from "@/components/plans/PlanStatusBadge";
import { InstallmentPlanListRow } from "@/lib/types";
import { formatCurrency, formatDateShort } from "@/lib/format";

/** A promise-to-pay is stored as a plan with tenureMonths === 1 and 0% interest — same table,
 *  just a different label, no separate page needed (see backend emiService.createPromisePlan).
 *  tenureMonths is null while an EMI offer is still awaiting the customer's choice. */
function planTypeLabel(p: InstallmentPlanListRow): string {
  if (p.tenureMonths === null) return "EMI Offer";
  return p.tenureMonths === 1 ? "Promise to Pay" : `${p.tenureMonths}-month EMI`;
}

export function PlanTable({ plans }: { plans: InstallmentPlanListRow[] }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Principal</TableHead>
            <TableHead className="hidden sm:table-cell">Monthly / Due Amount</TableHead>
            <TableHead className="hidden md:table-cell">Started</TableHead>
            <TableHead>Progress</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {plans.map((p) => {
            const total = p.paidCount + p.missedCount + p.pendingCount;
            return (
              <TableRow key={p.id} className="cursor-pointer">
                <TableCell className="font-medium">
                  <Link href={`/plans/${p.id}`} className="hover:underline">
                    {p.customer.name}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">{planTypeLabel(p)}</TableCell>
                <TableCell>{formatCurrency(p.principalAmount)}</TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  {p.monthlyAmount === null ? "TBD by customer" : formatCurrency(p.monthlyAmount)}
                </TableCell>
                <TableCell className="hidden text-muted-foreground md:table-cell">
                  {formatDateShort(p.startDate)}
                </TableCell>
                <TableCell className="min-w-32">
                  {p.status === "OFFERED" ? (
                    <span className="text-xs text-muted-foreground">
                      Expires {p.offerExpiresAt ? formatDateShort(p.offerExpiresAt) : "—"}
                    </span>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <Progress value={total > 0 ? (p.paidCount / total) * 100 : 0} className="h-2 w-16" />
                        <span className="text-xs text-muted-foreground">
                          {p.paidCount}/{total}
                        </span>
                      </div>
                      {p.missedCount > 0 && (
                        <span className="text-xs text-status-critical">{p.missedCount} missed</span>
                      )}
                    </>
                  )}
                </TableCell>
                <TableCell>
                  <PlanStatusBadge status={p.status} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
