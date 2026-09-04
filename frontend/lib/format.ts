export function formatCurrency(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(paise / 100);
}

export function formatCompactCurrency(paise: number): string {
  const rupees = paise / 100;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(rupees);
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

const ACTION_LABELS: Record<string, string> = {
  RETRY: "Retry",
  PAYMENT_LINK: "Payment Link",
  STOP: "Stop",
  ESCALATE: "Escalate",
  EMI_PLAN: "EMI Plan",
};
export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

const CATEGORY_LABELS: Record<string, string> = {
  TEMPORARY_FAILURE: "Temporary Failure",
  INSUFFICIENT_FUNDS: "Insufficient Funds",
  CHECKOUT_ABANDONED: "Checkout Abandoned",
  EXPIRED_PAYMENT: "Expired Payment",
  SUSPICIOUS_PAYMENT: "Suspicious",
  OTHER: "Other",
  NONE: "—",
};
export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}
