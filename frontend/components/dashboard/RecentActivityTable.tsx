import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { EmptyState } from "@/components/shared/States";
import { formatCurrency, formatDate, actionLabel } from "@/lib/format";
import { RecoveryAttempt } from "@/lib/types";
import { Sparkles } from "lucide-react";

export function RecentActivityTable({ attempts }: { attempts: RecoveryAttempt[] }) {
  if (attempts.length === 0) {
    return <EmptyState title="No recovery activity yet" description="Recovery attempts will appear here as failed payments come in." />;
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden sm:table-cell">Score</TableHead>
            <TableHead className="hidden md:table-cell">When</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {attempts.map((a) => (
            <TableRow key={a.id}>
              <TableCell className="font-medium">{a.payment.customer.name}</TableCell>
              <TableCell className="tabular-nums">{formatCurrency(a.payment.amount)}</TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1">
                  {actionLabel(a.action)}
                  {a.usedAI && <Sparkles className="size-3.5 text-chart-1" aria-label="AI-assisted" />}
                </span>
              </TableCell>
              <TableCell>
                <StatusBadge status={a.status} />
              </TableCell>
              <TableCell className="hidden tabular-nums sm:table-cell">{a.payment.recoveryScore ?? "—"}</TableCell>
              <TableCell className="hidden text-muted-foreground md:table-cell">{formatDate(a.createdAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
