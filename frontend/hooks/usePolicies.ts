import useSWR from "swr";
import { RecoveryPolicy } from "@/lib/types";

export function usePolicy() {
  return useSWR<{ policy: RecoveryPolicy }>("/api/policies");
}
