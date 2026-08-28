"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PolicyForm } from "@/components/policies/PolicyForm";
import { AuditTable } from "@/components/policies/AuditTable";
import { CardSkeleton, ErrorState, TableSkeleton } from "@/components/shared/States";
import { usePolicy } from "@/hooks/usePolicies";
import { useAuditLog } from "@/hooks/useAudit";

export default function PoliciesPage() {
  const { data: policyData, error: policyError, isLoading: policyLoading, mutate: mutatePolicy } = usePolicy();
  const { data: auditData, error: auditError, isLoading: auditLoading, mutate: mutateAudit } = useAuditLog();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Policies & Audit</h1>
        <p className="text-sm text-muted-foreground">
          Configure the guardrails every recovery action must pass, and review the complete, append-only audit trail.
        </p>
      </div>

      {policyError ? (
        <ErrorState title="Couldn't load policy" description={policyError.message} onRetry={() => mutatePolicy()} />
      ) : policyLoading || !policyData?.policy ? (
        <CardSkeleton />
      ) : (
        <PolicyForm policy={policyData.policy} onSaved={() => mutatePolicy()} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Audit Trail</CardTitle>
        </CardHeader>
        <CardContent>
          {auditError ? (
            <ErrorState title="Couldn't load audit log" description={auditError.message} onRetry={() => mutateAudit()} />
          ) : auditLoading || !auditData ? (
            <TableSkeleton rows={8} />
          ) : (
            <AuditTable logs={auditData.logs} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
