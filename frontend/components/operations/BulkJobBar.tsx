"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useBulkJob } from "@/hooks/useBulkJob";
import { CheckCircle2, XCircle, Loader2, X } from "lucide-react";

/** Companion to BulkActionBar for the "select all N matching this filter" flow — no id list, no
 *  200-item cap. Runs as a background job (see POST /api/recovery/bulk-jobs) and polls for
 *  progress, so it behaves identically whether "matching this filter" means 12 attempts or 12,000. */
export function BulkJobBar({
  total,
  filterQuery,
  onClear,
  onMutated,
}: {
  total: number;
  filterQuery: string;
  onClear: () => void;
  onMutated: () => void;
}) {
  const { job, error, run } = useBulkJob();
  const running = job?.status === "RUNNING";
  const handledRef = useRef<string | null>(null);

  useEffect(() => {
    if (!job || job.status === "RUNNING") return;
    // Each job's terminal state should only be handled once, even if this effect re-runs.
    const key = `${job.status}:${job.processed}`;
    if (handledRef.current === key) return;
    handledRef.current = key;

    if (job.status === "COMPLETED") {
      const verb = job.action === "approve" ? "Approved" : "Rejected";
      if (job.failed === 0) {
        toast.success(
          `${verb} ${job.succeeded.toLocaleString()} attempt${job.succeeded === 1 ? "" : "s"}.` +
            (job.truncated ? " More still match this filter — run it again to pick up the rest." : ""),
        );
      } else {
        toast.warning(
          `${job.succeeded.toLocaleString()} succeeded, ${job.failed.toLocaleString()} failed` +
            (job.errors[0] ? ` — e.g. ${job.errors[0].error}` : "") +
            ".",
        );
      }
      onMutated();
      onClear();
    } else if (job.status === "FAILED") {
      toast.error(job.error ?? "Bulk job failed.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  return (
    <div className="space-y-2 rounded-lg border bg-muted/40 px-4 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{total.toLocaleString()} matching this filter selected</p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClear} disabled={running}>
            <X className="size-4" />
            Clear
          </Button>
          <Button variant="outline" size="sm" disabled={running} onClick={() => run("reject", filterQuery)}>
            {running && job?.action === "reject" ? <Loader2 className="size-4 animate-spin" /> : <XCircle className="size-4" />}
            Reject all
          </Button>
          <Button size="sm" disabled={running} onClick={() => run("approve", filterQuery)}>
            {running && job?.action === "approve" ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
            Approve all
          </Button>
        </div>
      </div>

      {job && running && (
        <div className="space-y-1">
          <Progress value={job.total > 0 ? (job.processed / job.total) * 100 : 0} />
          <p className="text-xs text-muted-foreground">
            {job.total > 0
              ? `${job.processed.toLocaleString()} / ${job.total.toLocaleString()} processed…`
              : "Finding matching attempts…"}
          </p>
        </div>
      )}

      {error && <p className="text-xs text-status-critical">{error}</p>}
    </div>
  );
}
