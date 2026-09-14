import useSWR from "swr";

export interface RazorpayCredentialsStatus {
  razorpayKeyId: string | null;
  hasKeySecret: boolean;
  hasWebhookSecret: boolean;
  webhookPath: string;
}

export function useRazorpayCredentials() {
  return useSWR<RazorpayCredentialsStatus>("/api/merchant/razorpay-credentials");
}
