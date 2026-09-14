"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RecoveryPolicy } from "@/lib/types";
import { api, ApiError } from "@/lib/api";
import { Loader2, Save } from "lucide-react";

function formFromPolicy(policy: RecoveryPolicy) {
  return {
    maxRetries: policy.maxRetries,
    maxAutoRecoveryAmountRupees: policy.maxAutoRecoveryAmount / 100,
    maxCommunicationsPerPeriod: policy.maxCommunicationsPerPeriod,
    communicationPeriodHours: policy.communicationPeriodHours,
    quietHoursStart: policy.quietHoursStart,
    quietHoursEnd: policy.quietHoursEnd,
    minRetryIntervalMinutes: policy.minRetryIntervalMinutes,
    retryDelayMinutes: policy.retryDelayMinutes.join(", "),
  };
}

export function PolicyForm({ policy, onSaved }: { policy: RecoveryPolicy; onSaved: () => void }) {
  const [form, setForm] = useState(() => formFromPolicy(policy));
  const [saving, setSaving] = useState(false);

  // Re-derive the form whenever a *different* policy object comes in (e.g. after a refetch)
  // without an effect — adjusting state during render, as React recommends, avoids the extra
  // render pass an effect-based sync would cost.
  const [syncedPolicy, setSyncedPolicy] = useState(policy);
  if (policy !== syncedPolicy) {
    setSyncedPolicy(policy);
    setForm(formFromPolicy(policy));
  }

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    setSaving(true);
    try {
      const retryDelayMinutes = form.retryDelayMinutes
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => !Number.isNaN(n));

      await api.put("/api/policies", {
        maxRetries: Number(form.maxRetries),
        maxAutoRecoveryAmount: Math.round(Number(form.maxAutoRecoveryAmountRupees) * 100),
        maxCommunicationsPerPeriod: Number(form.maxCommunicationsPerPeriod),
        communicationPeriodHours: Number(form.communicationPeriodHours),
        quietHoursStart: Number(form.quietHoursStart),
        quietHoursEnd: Number(form.quietHoursEnd),
        minRetryIntervalMinutes: Number(form.minRetryIntervalMinutes),
        retryDelayMinutes: retryDelayMinutes.length > 0 ? retryDelayMinutes : [0],
      });
      toast.success("Policy updated.");
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save policy.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recovery Policy & Guardrails</CardTitle>
        <CardDescription>
          These limits are enforced by the backend policy engine on every recovery attempt — the AI agent cannot bypass them.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Max retries per payment" value={form.maxRetries} onChange={(v) => set("maxRetries", v)} />
        <Field
          label="Max auto-recovery amount (₹)"
          value={form.maxAutoRecoveryAmountRupees}
          onChange={(v) => set("maxAutoRecoveryAmountRupees", v)}
        />
        <Field
          label="Max communications per period"
          value={form.maxCommunicationsPerPeriod}
          onChange={(v) => set("maxCommunicationsPerPeriod", v)}
        />
        <Field
          label="Communication period (hours)"
          value={form.communicationPeriodHours}
          onChange={(v) => set("communicationPeriodHours", v)}
        />
        <Field label="Quiet hours start (0-23)" value={form.quietHoursStart} onChange={(v) => set("quietHoursStart", v)} />
        <Field label="Quiet hours end (0-23)" value={form.quietHoursEnd} onChange={(v) => set("quietHoursEnd", v)} />
        <Field
          label="Min minutes between retries"
          value={form.minRetryIntervalMinutes}
          onChange={(v) => set("minRetryIntervalMinutes", v)}
        />
        <div className="space-y-1.5">
          <Label>Dunning schedule (minutes delay per attempt)</Label>
          <Input value={form.retryDelayMinutes} onChange={(e) => set("retryDelayMinutes", e.target.value)} placeholder="0, 360, 1440" />
        </div>
      </CardContent>
      <CardFooter>
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          Save Policy
        </Button>
      </CardFooter>
    </Card>
  );
}

function Field({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}
