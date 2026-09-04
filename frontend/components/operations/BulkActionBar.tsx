"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { CheckCircle2, XCircle, Loader2, X } from "lucide-react";

interface BulkResult {
  id: string;
  ok: boolean;
  error?: string;
}

export function BulkActionBar({
  selectedIds,
  onClear,
  onMutated,
}: {
  selectedIds: string[];
  onClear: () => void;
  onMutated: () => void;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);

  if (selectedIds.length === 0) return null;

  async function run(kind: "approve" | "reject") {
    setBusy(kind);
    try {
      const { results, succeeded, failed } = await api.post<{
        results: BulkResult[];
        succeeded: number;
        failed: number;
      }>(`/api/recovery/bulk-${kind}`, { ids: selectedIds });

      if (failed === 0) {
        toast.success(`${kind === "approve" ? "Approved" : "Rejected"} ${succeeded} attempt${succeeded === 1 ? "" : "s"}.`);
      } else {
        const firstError = results.find((r) => !r.ok)?.error;
        toast.warning(`${succeeded} succeeded, ${failed} failed${firstError ? ` — ${firstError}` : ""}.`);
      }
      onClear();
      onMutated();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Bulk action failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-2.5">
      <p className="text-sm font-medium">
        {selectedIds.length} selected
      </p>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onClear} disabled={busy !== null}>
          <X className="size-4" />
          Clear
        </Button>
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => run("reject")}>
          {busy === "reject" ? <Loader2 className="size-4 animate-spin" /> : <XCircle className="size-4" />}
          Reject all
        </Button>
        <Button size="sm" disabled={busy !== null} onClick={() => run("approve")}>
          {busy === "approve" ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
          Approve all
        </Button>
      </div>
    </div>
  );
}
