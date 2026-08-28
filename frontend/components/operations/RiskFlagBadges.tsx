import { Badge } from "@/components/ui/badge";
import { AlertTriangle } from "lucide-react";

export function RiskFlagBadges({ flags }: { flags: string[] | null | undefined }) {
  if (!flags || flags.length === 0) return <span className="text-sm text-muted-foreground">None</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {flags.map((flag) => (
        <Badge key={flag} variant="outline" className="gap-1 border-status-warning/30 bg-status-warning/10 text-[#8a5a00] dark:text-status-warning">
          <AlertTriangle className="size-3" />
          {flag.replace(/_/g, " ")}
        </Badge>
      ))}
    </div>
  );
}
