import { Card, CardContent } from "@/components/ui/card";
import { Bot, BotOff } from "lucide-react";
import { cn } from "@/lib/utils";

export function AgentStatusCard({ status }: { status: "ONLINE" | "UNAVAILABLE" }) {
  const online = status === "ONLINE";
  return (
    <Card className="gap-3 py-5">
      <CardContent className="flex items-center gap-3 px-5">
        <div className={cn("rounded-lg p-2", online ? "bg-status-good/10 text-success-text" : "bg-muted text-muted-foreground")}>
          {online ? <Bot className="size-5" /> : <BotOff className="size-5" />}
        </div>
        <div>
          <p className="text-sm font-medium">AI Reasoning Agent</p>
          <p className="text-xs text-muted-foreground">
            {online
              ? "Online — reasoning over ambiguous cases only"
              : "Unavailable — ambiguous cases route to human review"}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
