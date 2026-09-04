import useSWR from "swr";
import { CustomerProfile } from "@/lib/types";

export function useCustomerProfile(id: string | null) {
  return useSWR<CustomerProfile>(id ? `/api/customers/${id}` : null, { refreshInterval: 15000 });
}
