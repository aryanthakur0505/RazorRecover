import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { SimulationJob } from "@/lib/types";

export function useSimulation() {
  const [job, setJob] = useState<SimulationJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const run = useCallback(
    async (size: 100 | 500 | 1000) => {
      setError(null);
      setJob({ status: "RUNNING", processed: 0, total: size });
      try {
        const { jobId } = await api.post<{ jobId: string }>("/api/simulation/run", { size });
        stopPolling();
        pollRef.current = setInterval(async () => {
          try {
            const latest = await api.get<SimulationJob>(`/api/simulation/${jobId}`);
            setJob(latest);
            if (latest.status !== "RUNNING") stopPolling();
          } catch {
            stopPolling();
            setError("Lost connection while polling simulation progress.");
          }
        }, 1200);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to start simulation.");
        setJob(null);
      }
    },
    [stopPolling],
  );

  return { job, error, run };
}
