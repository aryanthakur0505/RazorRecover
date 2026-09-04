import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate, categoryLabel } from "@/lib/format";
import { ReEngagementRow } from "@/lib/types";
import { Clock } from "lucide-react";

export function ReEngagementTable({ rows, bucket }: { rows: ReEngagementRow[]; bucket: "cooling_down" | "exhausted" }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Attempts so far</TableHead>
            <TableHead>Last contact</TableHead>
            <TableHead>{bucket === "cooling_down" ? "Auto-retries" : "Status"}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.paymentId}>
              <TableCell className="font-medium">
                <Link href={`/customers/${r.customer.id}`} className="hover:underline">
                  {r.customer.name}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">{categoryLabel(r.failureCategory)}</TableCell>
              <TableCell>{formatCurrency(r.amount)}</TableCell>
              <TableCell className="text-muted-foreground">{r.attemptNumber}</TableCell>
              <TableCell className="text-muted-foreground">{formatDate(r.lastAttemptAt)}</TableCell>
              <TableCell>
                {bucket === "cooling_down" ? (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="size-3" />
                    {r.nextEligibleAt ? `Eligible ${formatDate(r.nextEligibleAt)}` : "Eligible now"}
                  </span>
                ) : (
                  <Badge variant="outline" className="gap-1 border-transparent bg-muted text-muted-foreground">
                    Max retries reached — needs a decision
                  </Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
