import { EmptyState } from "@/components/shared/States";

export function OutcomeSplit({ succeeded, failed }: { succeeded: number; failed: number }) {
  const total = succeeded + failed;
  if (total === 0) {
    return <EmptyState title="No resolved attempts yet" description="Outcomes appear here once recovery attempts succeed or fail." />;
  }
  const succeededPct = (succeeded / total) * 100;
  const failedPct = 100 - succeededPct;

  return (
    <div className="space-y-4">
      <div className="flex h-3 overflow-hidden rounded-full bg-muted">
        <div className="bg-status-good" style={{ width: `${succeededPct}%` }} />
        <div className="bg-status-critical" style={{ width: `${failedPct}%` }} />
      </div>
      <div className="flex justify-between text-sm">
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-full bg-status-good" />
          <span className="text-muted-foreground">Recovered</span>
          <span className="font-mono font-medium tabular-nums">{succeeded}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-full bg-status-critical" />
          <span className="text-muted-foreground">Not Recovered</span>
          <span className="font-mono font-medium tabular-nums">{failed}</span>
        </div>
      </div>
    </div>
  );
}
