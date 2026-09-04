import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CheckCircle2, Clock, XCircle, Ban, MailQuestion, Hourglass } from "lucide-react";
import { InstallmentPlanStatus } from "@/lib/types";

const CONFIG: Record<InstallmentPlanStatus, { label: string; icon: typeof CheckCircle2; className: string }> = {
  OFFERED: { label: "Awaiting Choice", icon: MailQuestion, className: "bg-status-warning/15 text-[#8a5a00] dark:text-status-warning" },
  ACTIVE: { label: "Active", icon: Clock, className: "bg-chart-1/15 text-chart-1" },
  COMPLETED: { label: "Completed", icon: CheckCircle2, className: "bg-status-good/15 text-success-text" },
  DEFAULTED: { label: "Defaulted", icon: XCircle, className: "bg-status-critical/15 text-status-critical" },
  EXPIRED: { label: "Offer Expired", icon: Hourglass, className: "bg-muted text-muted-foreground" },
  CANCELLED: { label: "Cancelled", icon: Ban, className: "bg-muted text-muted-foreground" },
};

export function PlanStatusBadge({ status, className }: { status: InstallmentPlanStatus; className?: string }) {
  const config = CONFIG[status];
  const Icon = config.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 border-transparent font-medium", config.className, className)}>
      <Icon className="size-3" />
      {config.label}
    </Badge>
  );
}
