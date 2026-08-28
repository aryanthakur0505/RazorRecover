import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { EmptyState } from "@/components/shared/States";
import { formatCurrency, actionLabel, categoryLabel } from "@/lib/format";
import { RecoveryAttempt } from "@/lib/types";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export function OpportunityTable({
  attempts,
  onSelect,
}: {
  attempts: RecoveryAttempt[];
  onSelect: (id: string) => void;
}) {
  if (attempts.length === 0) {
    return <EmptyState title="No recovery opportunities in this view" description="Try a different filter, or run a simulation from the Command Center." />;
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead className="hidden sm:table-cell">Failure</TableHead>
            <TableHead className="hidden md:table-cell">Score</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {attempts.map((a) => (
            <TableRow
              key={a.id}
              className="cursor-pointer"
              onClick={() => onSelect(a.id)}
            >
              <TableCell className="font-medium">{a.payment.customer.name}</TableCell>
              <TableCell className="tabular-nums">{formatCurrency(a.payment.amount)}</TableCell>
              <TableCell className="hidden sm:table-cell">{categoryLabel(a.payment.failureCategory)}</TableCell>
              <TableCell className="hidden md:table-cell">
                <span
                  className={cn(
                    "font-mono tabular-nums",
                    (a.payment.recoveryScore ?? 0) >= 70
                      ? "text-success-text"
                      : (a.payment.recoveryScore ?? 0) >= 40
                        ? "text-[#8a5a00] dark:text-status-warning"
                        : "text-status-critical",
                  )}
                >
                  {a.payment.recoveryScore ?? "—"}
                </span>
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1">
                  {actionLabel(a.action)}
                  {a.usedAI && <Sparkles className="size-3.5 text-chart-1" aria-label="AI-assisted" />}
                </span>
              </TableCell>
              <TableCell>
                <StatusBadge status={a.status} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
