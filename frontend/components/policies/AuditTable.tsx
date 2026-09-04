"use client";

import { Fragment, useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/States";
import { formatDate, formatCurrency } from "@/lib/format";
import { withDayDividers } from "@/lib/dateGroups";
import { AuditLogEntry } from "@/lib/types";

const COLUMN_COUNT = 4;

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
  DO_NOT_CONTACT_ENABLED: "Do-Not-Contact Enabled",
  DO_NOT_CONTACT_DISABLED: "Do-Not-Contact Disabled",
  CUSTOMER_NOTE_ADDED: "Customer Note Added",
  RETRY_OVERRIDE_REQUESTED: "Retry Override Requested",
};

// AuditLog is one shared table across every event type in the system, so a given event only ever
// populates a handful of its ~20 columns — the rest are genuinely inapplicable, not missing data.
// Dumping the full row (the old behavior) meant opening any entry showed mostly nulls, forcing
// whoever's reading the audit trail to hunt for the few fields that actually mean something. This
// renders only the fields this specific event actually set, with human labels instead of raw keys.
const FIELD_LABELS: Partial<Record<keyof AuditLogEntry, string>> = {
  paymentId: "Payment",
  customerId: "Customer",
  attemptId: "Attempt",
  amount: "Amount",
  failureReason: "Reason",
  recoveryScore: "Recovery Score",
  decisionFactors: "Decision Factors",
  aiRecommendation: "AI Recommendation",
  policyChecks: "Policy Checks",
  idempotencyKey: "Idempotency Key",
  approvalStatus: "Approval Status",
  action: "Action",
  apiResult: "API Result",
  outcome: "Outcome",
  revenueRecovered: "Revenue Recovered",
  recoveryCost: "Recovery Cost",
  netRecovered: "Net Recovered",
};

// Redundant with what the dialog already shows elsewhere (title, timestamp) or purely internal —
// never worth its own row.
const HIDDEN_FIELDS = new Set<keyof AuditLogEntry>(["id", "merchantId", "eventType", "timestamp"]);
const CURRENCY_FIELDS = new Set<keyof AuditLogEntry>(["amount", "revenueRecovered", "recoveryCost", "netRecovered"]);
const JSON_FIELDS = new Set<keyof AuditLogEntry>(["decisionFactors", "aiRecommendation", "policyChecks", "apiResult"]);

function detailEntries(log: AuditLogEntry) {
  return (Object.entries(log) as [keyof AuditLogEntry, unknown][]).filter(
    ([key, value]) => !HIDDEN_FIELDS.has(key) && value !== null && value !== undefined && value !== "",
  );
}

export function AuditTable({ logs }: { logs: AuditLogEntry[] }) {
  const [selected, setSelected] = useState<AuditLogEntry | null>(null);

  if (logs.length === 0) {
    return (
      <EmptyState
        title="No audit events match this view"
        description="Try a different search or date range — every webhook, decision, and action is recorded here, append-only."
      />
    );
  }

  const rows = withDayDividers(logs, (log) => log.timestamp);

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
            {rows.map(({ item: log, divider }) => (
              <Fragment key={log.id}>
                {divider && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={COLUMN_COUNT} className="bg-muted/40 py-1.5 text-xs font-medium text-muted-foreground">
                      {divider}
                    </TableCell>
                  </TableRow>
                )}
                <TableRow className="cursor-pointer" onClick={() => setSelected(log)}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(log.timestamp)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{EVENT_LABELS[log.eventType] ?? log.eventType}</Badge>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">{log.outcome ?? "—"}</TableCell>
                  <TableCell className="hidden tabular-nums md:table-cell">
                    {log.netRecovered !== null ? formatCurrency(log.netRecovered) : "—"}
                  </TableCell>
                </TableRow>
              </Fragment>
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
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">{formatDate(selected.timestamp)}</p>
              {(() => {
                const entries = detailEntries(selected);
                if (entries.length === 0) {
                  return <p className="text-sm text-muted-foreground">No further detail recorded for this event.</p>;
                }
                return (
                  <dl className="space-y-3 text-sm">
                    {entries.map(([key, value]) => (
                      <div key={key}>
                        <dt className="text-xs font-medium text-muted-foreground">{FIELD_LABELS[key] ?? key}</dt>
                        <dd className="mt-0.5">
                          {JSON_FIELDS.has(key) ? (
                            <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
                              {JSON.stringify(value, null, 2)}
                            </pre>
                          ) : CURRENCY_FIELDS.has(key) ? (
                            <span className="font-mono tabular-nums">{formatCurrency(value as number)}</span>
                          ) : (
                            <span className="whitespace-pre-wrap">{String(value)}</span>
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                );
              })()}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
