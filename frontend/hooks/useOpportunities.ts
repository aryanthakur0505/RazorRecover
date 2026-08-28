import useSWR from "swr";
import { RecoveryAttempt } from "@/lib/types";

export function useOpportunities(status?: string) {
  const key = status ? `/api/recovery/opportunities?status=${status}` : "/api/recovery/opportunities";
  return useSWR<{ attempts: RecoveryAttempt[] }>(key, { refreshInterval: 8000 });
}

export function useOpportunity(id: string | null) {
  return useSWR<{ attempt: RecoveryAttempt & { auditLogs: unknown[] } }>(
    id ? `/api/recovery/${id}` : null,
    { refreshInterval: 5000 },
  );
}
