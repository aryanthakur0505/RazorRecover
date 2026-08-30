import useSWR from "swr";
import { DashboardMetrics, ChartsResponse, RecoveryAttempt, AIShadowComparison } from "@/lib/types";

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

export function useAIComparison() {
  return useSWR<AIShadowComparison>("/api/metrics/ai-comparison", { refreshInterval: 20000 });
}
