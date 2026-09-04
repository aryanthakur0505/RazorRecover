"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { CustomerNote } from "@/lib/types";
import { StickyNote, Loader2, Plus } from "lucide-react";

/** Free-text, append-only notes on a customer — "called them, said they'll pay Friday", "our
 *  biggest account, always approve". Merchant-only context, never shown to the customer. */
export function CustomerNotes({
  customerId,
  notes,
  onAdded,
}: {
  customerId: string;
  notes: CustomerNote[];
  onAdded: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await api.post(`/api/customers/${customerId}/notes`, { body });
      setDraft("");
      onAdded();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not add the note.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <StickyNote className="size-4 text-chart-1" />
          Notes
        </CardTitle>
        <CardDescription>Context for whoever looks at this customer next — never shown to the customer.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. Called them, said they'll pay by Friday. Or: our biggest account, always approve."
            rows={2}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
          />
          <div className="flex justify-end">
            <Button size="sm" disabled={busy || !draft.trim()} onClick={submit}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Add note
            </Button>
          </div>
        </div>

        {notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No notes yet.</p>
        ) : (
          <ul className="space-y-3">
            {notes.map((n) => (
              <li key={n.id} className="rounded-md border bg-muted/20 p-3 text-sm">
                <p className="whitespace-pre-wrap">{n.body}</p>
                <p className="mt-1 text-xs text-muted-foreground">{formatDate(n.createdAt)}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
