import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { BulkJob } from "@/lib/types";

/** Mirrors useSimulation — kick off a background job, poll it, surface progress. Used for the
 *  "select all N matching this filter" bulk approve/reject, which (unlike the checkbox-based bulk
 *  actions) has no fixed upper bound on how many attempts it might touch. */
export function useBulkJob() {
  const [job, setJob] = useState<BulkJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const run = useCallback(
    async (action: "approve" | "reject", filterQuery: string) => {
      setError(null);
      setJob({ status: "RUNNING", action, processed: 0, total: 0, succeeded: 0, failed: 0, errors: [], truncated: false });
      try {
        const { jobId } = await api.post<{ jobId: string }>(
          `/api/recovery/bulk-jobs${filterQuery ? `?${filterQuery}` : ""}`,
          { action },
        );
        stopPolling();
        pollRef.current = setInterval(async () => {
          try {
            const latest = await api.get<BulkJob>(`/api/recovery/bulk-jobs/${jobId}`);
            setJob(latest);
            if (latest.status !== "RUNNING") stopPolling();
          } catch {
            stopPolling();
            setError("Lost connection while polling bulk job progress.");
          }
        }, 1000);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to start bulk job.");
        setJob(null);
      }
    },
    [stopPolling],
  );

  const reset = useCallback(() => {
    stopPolling();
    setJob(null);
    setError(null);
  }, [stopPolling]);

  return { job, error, run, reset };
}
