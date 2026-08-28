"use client";

import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/States";
import { formatDate, formatCurrency } from "@/lib/format";
import { AuditLogEntry } from "@/lib/types";

const EVENT_LABELS: Record<string, string> = {
  WEBHOOK_RECEIVED: "Webhook Received",
  SCORE_CALCULATED: "Score Calculated",
  AI_RECOMMENDATION: "AI Recommendation",
  AI_UNAVAILABLE: "AI Unavailable",
  RECOVERY_ATTEMPT_CREATED: "Attempt Created",
  APPROVAL_REQUIRED: "Approval Required",
  APPROVAL_DECISION: "Approval Decision",
  POLICY_BLOCKED: "Policy Blocked",
  ACTION_EXECUTED: "Action Executed",
  ACTION_EXECUTION_FAILED: "Execution Failed",
  OUTCOME_RECORDED: "Outcome Recorded",
  POLICY_UPDATED: "Policy Updated",
};

export function AuditTable({ logs }: { logs: AuditLogEntry[] }) {
  const [selected, setSelected] = useState<AuditLogEntry | null>(null);

  if (logs.length === 0) {
    return <EmptyState title="No audit events yet" description="Every webhook, decision, and action will be recorded here — append-only." />;
  }

  return (
    <>
      <div className="max-h-[520px] overflow-auto rounded-md border">
        <Table>
          <TableHeader className="sticky top-0 bg-background">
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Event</TableHead>
              <TableHead className="hidden sm:table-cell">Outcome</TableHead>
              <TableHead className="hidden md:table-cell">Net</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.map((log) => (
              <TableRow key={log.id} className="cursor-pointer" onClick={() => setSelected(log)}>
                <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(log.timestamp)}</TableCell>
                <TableCell>
                  <Badge variant="outline">{EVENT_LABELS[log.eventType] ?? log.eventType}</Badge>
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">{log.outcome ?? "—"}</TableCell>
                <TableCell className="hidden tabular-nums md:table-cell">
                  {log.netRecovered !== null ? formatCurrency(log.netRecovered) : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{selected ? (EVENT_LABELS[selected.eventType] ?? selected.eventType) : ""}</DialogTitle>
          </DialogHeader>
          {selected && (
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
              {JSON.stringify(selected, null, 2)}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
