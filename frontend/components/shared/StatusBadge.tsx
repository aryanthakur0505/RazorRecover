import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CheckCircle2, Clock, XCircle, PauseCircle, AlertTriangle, Loader2, Ban } from "lucide-react";

type Status =
  | "PENDING"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "EXECUTING"
  | "EXECUTED"
  | "SUCCEEDED"
  | "FAILED"
  | "STOPPED"
  | "CREATED"
  | "AUTHORIZED"
  | "CAPTURED"
  | "REFUNDED";

const CONFIG: Record<Status, { label: string; icon: typeof CheckCircle2; className: string }> = {
  PENDING: { label: "Pending", icon: Clock, className: "bg-muted text-muted-foreground" },
  AWAITING_APPROVAL: {
    label: "Needs Approval",
    icon: AlertTriangle,
    className: "bg-status-warning/15 text-[#8a5a00] dark:text-status-warning",
  },
  APPROVED: { label: "Approved", icon: CheckCircle2, className: "bg-chart-1/15 text-chart-1" },
  REJECTED: { label: "Rejected", icon: XCircle, className: "bg-status-critical/15 text-status-critical" },
  EXECUTING: { label: "Executing", icon: Loader2, className: "bg-chart-1/15 text-chart-1" },
  // "Executed" undersold what this actually means: the action was sent (link/escalation/EMI
  // offer) and now genuinely depends on someone else acting — the customer clicking a link,
  // picking an EMI tenure, or a human's follow-up landing. Not won, not lost, still in play.
  EXECUTED: { label: "Recovering", icon: Clock, className: "bg-chart-1/15 text-chart-1" },
  SUCCEEDED: { label: "Recovered", icon: CheckCircle2, className: "bg-status-good/15 text-success-text" },
  FAILED: { label: "Not Recovered", icon: XCircle, className: "bg-status-critical/15 text-status-critical" },
  STOPPED: { label: "Stopped", icon: Ban, className: "bg-muted text-muted-foreground" },
  CREATED: { label: "Created", icon: Clock, className: "bg-muted text-muted-foreground" },
  AUTHORIZED: { label: "Authorized", icon: Clock, className: "bg-chart-1/15 text-chart-1" },
  CAPTURED: { label: "Captured", icon: CheckCircle2, className: "bg-status-good/15 text-success-text" },
  REFUNDED: { label: "Refunded", icon: PauseCircle, className: "bg-muted text-muted-foreground" },
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const config = CONFIG[status as Status] ?? {
    label: status,
    icon: Clock,
    className: "bg-muted text-muted-foreground",
  };
  const Icon = config.icon;
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 border-transparent font-medium", config.className, className)}
    >
      <Icon className={cn("size-3", status === "EXECUTING" && "animate-spin")} />
      {config.label}
    </Badge>
  );
}
