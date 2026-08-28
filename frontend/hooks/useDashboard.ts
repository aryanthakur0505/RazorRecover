import useSWR from "swr";
import { DashboardMetrics, ChartsResponse, RecoveryAttempt } from "@/lib/types";

export function useDashboardMetrics() {
  return useSWR<DashboardMetrics>("/api/metrics/dashboard", { refreshInterval: 15000 });
}

export function useCharts() {
  return useSWR<ChartsResponse>("/api/metrics/charts", { refreshInterval: 20000 });
}

export function useRecentActivity() {
  return useSWR<{ attempts: RecoveryAttempt[] }>("/api/metrics/recent-activity", {
    refreshInterval: 10000,
  });
}
