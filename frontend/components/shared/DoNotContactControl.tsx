"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { BellOff, Bell, Loader2 } from "lucide-react";
import { Customer } from "@/lib/types";

/** Shared do-not-contact toggle — used from the Decision Drawer (per-attempt context) and the
 *  Customer Profile page (per-customer context) so the two never drift on behavior. Turning it on
 *  immediately stops any of this customer's queued attempts (see the backend route); turning it
 *  off does not resurrect anything already stopped. */
export function DoNotContactControl({
  customer,
  onMutated,
}: {
  customer: Pick<Customer, "id" | "name" | "doNotContact" | "doNotContactReason" | "doNotContactAt">;
  onMutated: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function setDoNotContact(doNotContact: boolean, reasonText?: string) {
    setBusy(true);
    try {
      const { stoppedCount } = await api.patch<{ stoppedCount: number }>(
        `/api/customers/${customer.id}/do-not-contact`,
        { doNotContact, reason: reasonText },
      );
      toast.success(
        doNotContact
          ? `Added to do-not-contact list.${stoppedCount ? ` Stopped ${stoppedCount} queued attempt${stoppedCount === 1 ? "" : "s"}.` : ""}`
          : "Removed from do-not-contact list.",
      );
      setPending(false);
      setReason("");
      onMutated();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update the do-not-contact list.");
    } finally {
      setBusy(false);
    }
  }

  if (customer.doNotContact) {
    return (
      <div className="flex items-start justify-between gap-3 rounded-md border border-dashed p-3">
        <div className="space-y-1">
          <Badge variant="outline" className="gap-1 border-status-critical/30 bg-status-critical/10 text-status-critical">
            <BellOff className="size-3" />
            On do-not-contact list
          </Badge>
          <p className="text-xs text-muted-foreground">
            {customer.doNotContactReason || "No reason given"}
            {customer.doNotContactAt && ` · since ${formatDate(customer.doNotContactAt)}`}
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setDoNotContact(false)}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Bell className="size-4" />}
          Remove
        </Button>
      </div>
    );
  }

  if (pending) {
    return (
      <div className="space-y-1.5 rounded-md border border-dashed p-3">
        <Label htmlFor="dnc-reason">Add {customer.name} to the do-not-contact list</Label>
        <Textarea
          id="dnc-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional) — e.g. known fraud, already refunded, asked not to be contacted."
          rows={2}
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPending(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy} onClick={() => setDoNotContact(true, reason || undefined)}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <BellOff className="size-4" />}
            Confirm
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Button variant="outline" size="sm" onClick={() => setPending(true)}>
      <BellOff className="size-4" />
      Add to do-not-contact list
    </Button>
  );
}
