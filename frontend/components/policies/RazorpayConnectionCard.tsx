"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CardSkeleton, ErrorState } from "@/components/shared/States";
import { useRazorpayCredentials } from "@/hooks/useMerchant";
import { api, ApiError } from "@/lib/api";
import { CheckCircle2, CircleDashed, Loader2, Save, Copy } from "lucide-react";

/**
 * Each merchant connects their own Razorpay Test Mode account — this is what makes an incoming
 * webhook attributable to the right merchant now that there's more than one (see
 * routes/webhooks.ts). The key secret and webhook secret are write-only from here on: once set,
 * this form only ever shows whether one is configured, never its value (the backend's GET route
 * never returns it either — see routes/merchant.ts).
 */
export function RazorpayConnectionCard() {
  const { data, error, isLoading, mutate } = useRazorpayCredentials();
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [saving, setSaving] = useState(false);

  // Prefill just the (non-secret) key id once it loads, so re-saving the webhook secret alone
  // doesn't require retyping it — adjusted during render rather than an effect, same pattern used
  // by PolicyForm for the same reason (see its own comment).
  // `syncedKeyId` mirrors data.razorpayKeyId's own type (string | null) exactly, rather than
  // coalescing it to undefined here — coalescing it meant the comparison below (`null !== undefined`)
  // was true on every render even right after "syncing" to the coalesced value, which re-triggered
  // the same setState every render: an infinite loop that only showed up for a merchant with no key
  // id set yet (the coalesced case in the first place).
  const [syncedKeyId, setSyncedKeyId] = useState<string | null | undefined>(undefined);
  if (data && data.razorpayKeyId !== syncedKeyId) {
    setSyncedKeyId(data.razorpayKeyId);
    setKeyId(data.razorpayKeyId ?? "");
  }

  async function save() {
    setSaving(true);
    try {
      await api.put("/api/merchant/razorpay-credentials", {
        razorpayKeyId: keyId,
        ...(keySecret ? { razorpayKeySecret: keySecret } : {}),
        ...(webhookSecret ? { razorpayWebhookSecret: webhookSecret } : {}),
      });
      setKeySecret("");
      setWebhookSecret("");
      toast.success("Razorpay connection updated.");
      await mutate();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save Razorpay credentials.");
    } finally {
      setSaving(false);
    }
  }

  async function copyWebhookUrl() {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      toast.success("Webhook URL copied.");
    } catch {
      toast.error("Couldn't copy — copy it manually instead.");
    }
  }

  if (error) {
    return <ErrorState title="Couldn't load Razorpay connection" description={error.message} onRetry={() => mutate()} />;
  }
  if (isLoading || !data) {
    return <CardSkeleton />;
  }

  const connected = Boolean(data.razorpayKeyId && data.hasKeySecret && data.hasWebhookSecret);
  const webhookUrl = `${process.env.NEXT_PUBLIC_API_URL ?? ""}${data.webhookPath}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {connected ? (
            <CheckCircle2 className="size-4 text-status-good" />
          ) : (
            <CircleDashed className="size-4 text-muted-foreground" />
          )}
          Razorpay Connection
        </CardTitle>
        <CardDescription>
          {connected
            ? "Connected — live webhooks and recovery actions (retry, payment link) use this account."
            : "Not connected yet — retries, payment links, and live webhooks won't work until this is set. Simulations still work without it."}{" "}
          Uses your own Razorpay <b>Test Mode</b> credentials (dashboard → Settings → API Keys / Webhooks).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="webhook-url">Webhook URL — paste this into your Razorpay dashboard</Label>
          <div className="flex gap-2">
            <Input id="webhook-url" readOnly value={webhookUrl} className="font-mono text-xs" />
            <Button type="button" variant="outline" size="icon" onClick={copyWebhookUrl} aria-label="Copy webhook URL">
              <Copy className="size-4" />
            </Button>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="key-id">Key ID</Label>
          <Input id="key-id" placeholder="rzp_test_…" value={keyId} onChange={(e) => setKeyId(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="key-secret">Key Secret {data.hasKeySecret && <span className="text-muted-foreground">(configured — leave blank to keep it)</span>}</Label>
          <Input
            id="key-secret"
            type="password"
            placeholder={data.hasKeySecret ? "••••••••••••" : "Paste your key secret"}
            value={keySecret}
            onChange={(e) => setKeySecret(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="webhook-secret">
            Webhook Secret {data.hasWebhookSecret && <span className="text-muted-foreground">(configured — leave blank to keep it)</span>}
          </Label>
          <Input
            id="webhook-secret"
            type="password"
            placeholder={data.hasWebhookSecret ? "••••••••••••" : "Set in Razorpay dashboard → Webhooks"}
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
          />
        </div>
      </CardContent>
      <CardFooter>
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          Save Connection
        </Button>
      </CardFooter>
    </Card>
  );
}
