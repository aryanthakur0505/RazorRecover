import { Fragment } from "react";
import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { EmptyState } from "@/components/shared/States";
import { formatCurrency, actionLabel, categoryLabel } from "@/lib/format";
import { withDayDividers } from "@/lib/dateGroups";
import { RecoveryAttempt } from "@/lib/types";
import { Sparkles, BellOff } from "lucide-react";
import { cn } from "@/lib/utils";

const COLUMN_COUNT = 7;

/** Only awaiting-approval attempts can be bulk-acted on — same restriction the single approve/
 *  reject routes already enforce, so a merchant never sees a checkbox promise an action the
 *  backend would reject anyway. */
function isSelectable(a: RecoveryAttempt) {
  return a.status === "AWAITING_APPROVAL";
}

export function OpportunityTable({
  attempts,
  onSelect,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  total,
  hasMore,
  onSelectAllMatching,
}: {
  attempts: RecoveryAttempt[];
  onSelect: (id: string) => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: (ids: string[], checked: boolean) => void;
  /** Total rows matching the current filter (not just what's loaded) — used only for the "select
   *  all matching" banner text. */
  total: number;
  hasMore: boolean;
  /** Present only when "select all matching this filter" is a valid action for the current view
   *  (the parent restricts this to the Needs Approval tab, where `total` really does mean "total
   *  awaiting approval"). Undefined hides the banner entirely. */
  onSelectAllMatching?: () => void;
}) {
  if (attempts.length === 0) {
    return (
      <EmptyState
        title="No recovery opportunities match this view"
        description="Try a different search, date range, or status filter, or run a simulation from the Command Center."
      />
    );
  }

  const rows = withDayDividers(attempts, (a) => a.createdAt);
  const selectableIds = attempts.filter(isSelectable).map((a) => a.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));

  const showSelectAllMatchingBanner = Boolean(onSelectAllMatching) && allSelected && hasMore;

  return (
    <div className="overflow-x-auto">
      {showSelectAllMatchingBanner && (
        <div className="flex flex-wrap items-center justify-center gap-1.5 border-b bg-muted/20 py-2 text-sm">
          <span className="text-muted-foreground">
            All {selectableIds.length.toLocaleString()} awaiting approval on this page are selected.
          </span>
          <button
            type="button"
            className="font-medium text-primary underline-offset-2 hover:underline"
            onClick={onSelectAllMatching}
          >
            Select all {total.toLocaleString()} matching this filter
          </button>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              {selectableIds.length > 0 && (
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={(checked) => onToggleSelectAll(selectableIds, checked === true)}
                  aria-label="Select all awaiting-approval attempts"
                />
              )}
            </TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead className="hidden sm:table-cell">Failure</TableHead>
            <TableHead className="hidden md:table-cell">Score</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ item: a, divider }) => (
            <Fragment key={a.id}>
              {divider && (
                <TableRow key={`divider-${a.id}`} className="hover:bg-transparent">
                  <TableCell colSpan={COLUMN_COUNT} className="bg-muted/40 py-1.5 text-xs font-medium text-muted-foreground">
                    {divider}
                  </TableCell>
                </TableRow>
              )}
              <TableRow
                className={cn("cursor-pointer", selectedIds.has(a.id) && "bg-muted/40")}
                onClick={() => onSelect(a.id)}
              >
                <TableCell onClick={(e) => e.stopPropagation()}>
                  {isSelectable(a) && (
                    <Checkbox
                      checked={selectedIds.has(a.id)}
                      onCheckedChange={() => onToggleSelect(a.id)}
                      aria-label={`Select ${a.payment.customer.name}`}
                    />
                  )}
                </TableCell>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-1.5">
                    <Link
                      href={`/customers/${a.payment.customer.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="hover:underline"
                    >
                      {a.payment.customer.name}
                    </Link>
                    {a.payment.customer.doNotContact && (
                      <BellOff className="size-3.5 shrink-0 text-muted-foreground" aria-label="Do not contact" />
                    )}
                  </div>
                </TableCell>
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
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
