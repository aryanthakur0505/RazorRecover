import useSWR from "swr";
import { AuditLogEntry } from "@/lib/types";

export function useAuditLog(limit = 100) {
  return useSWR<{ logs: AuditLogEntry[] }>(`/api/audit?limit=${limit}`, { refreshInterval: 10000 });
}
