"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/shared/States";
import { LoadMoreFooter } from "@/components/shared/LoadMoreFooter";
import { useDoNotContactList } from "@/hooks/useDoNotContact";
import { api, ApiError } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { BellOff, Bell, Loader2 } from "lucide-react";

export function DoNotContactList() {
  const { customers, total, hasMore, loadMore, isLoading, isLoadingMore, error, mutate } = useDoNotContactList();
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function remove(id: string) {
    setRemovingId(id);
    try {
      await api.patch(`/api/customers/${id}/do-not-contact`, { doNotContact: false });
      toast.success("Removed from the do-not-contact list.");
      await mutate();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not remove.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellOff className="size-4 text-chart-1" />
          Do-Not-Contact List
        </CardTitle>
        <CardDescription>
          Customers excluded from automatic retries and payment links — set from their profile or a
          recovery decision. Escalate (human review) still reaches them; nothing automatic does.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <ErrorState title="Couldn't load the do-not-contact list" description={error.message} onRetry={() => mutate()} />
        ) : isLoading ? (
          <TableSkeleton rows={3} />
        ) : customers.length === 0 ? (
          <EmptyState
            icon={BellOff}
            title="No one is on the do-not-contact list"
            description="Add a customer from their profile page or from a recovery decision to exclude them from automatic retries and payment links."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead className="hidden sm:table-cell">Email</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="hidden md:table-cell">Since</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {customers.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">
                        <Link href={`/customers/${c.id}`} className="hover:underline">
                          {c.name}
                        </Link>
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground sm:table-cell">{c.email}</TableCell>
                      <TableCell className="text-muted-foreground">{c.doNotContactReason || "No reason given"}</TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">
                        {c.doNotContactAt ? formatDate(c.doNotContactAt) : "—"}
                      </TableCell>
                      <TableCell>
                        <Button variant="outline" size="sm" disabled={removingId === c.id} onClick={() => remove(c.id)}>
                          {removingId === c.id ? <Loader2 className="size-4 animate-spin" /> : <Bell className="size-4" />}
                          Remove
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <LoadMoreFooter shown={customers.length} total={total} hasMore={hasMore} loading={isLoadingMore} onLoadMore={loadMore} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
