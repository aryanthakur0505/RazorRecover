"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { CustomerSearchResult } from "@/lib/types";
import { Search, User, BellOff, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** Global command palette (Ctrl/Cmd+K) — jump straight to a customer by name or email instead of
 *  hunting through Recovery Operations. Scoped to customers on purpose: they're the only entity
 *  in the app with a page of their own to land on. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const debouncedQuery = useDebouncedValue(query, 200);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = debouncedQuery.trim();
  const { data, isLoading } = useSWR<{ customers: CustomerSearchResult[] }>(
    open && trimmed.length >= 2 ? `/api/customers?q=${encodeURIComponent(trimmed)}` : null,
  );
  const results = data?.customers ?? [];

  // Reset the query + highlighted row whenever the dialog transitions to open, and reset just the
  // highlighted row whenever the (debounced) search text changes — both adjusted during render
  // rather than in an effect, so the reset is visible in the very same paint as the change.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setActiveIndex(0);
    }
  }
  const [syncedTrimmed, setSyncedTrimmed] = useState(trimmed);
  if (trimmed !== syncedTrimmed) {
    setSyncedTrimmed(trimmed);
    setActiveIndex(0);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Focusing the input is a genuine imperative side effect (not state), so it stays in an effect.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  function select(customer: CustomerSearchResult) {
    setOpen(false);
    router.push(`/customers/${customer.id}`);
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = results[activeIndex];
      if (chosen) select(chosen);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="hidden gap-2 text-muted-foreground sm:flex" size="sm">
          <Search className="size-4" />
          Search customers…
          {/* A fixed label, not a platform-detected one — reading navigator.platform on the
              client but not the server would mismatch the initial SSR render. */}
          <kbd className="ml-2 rounded border bg-muted px-1.5 py-0.5 font-mono text-[0.7rem] text-muted-foreground">
            Ctrl/⌘ K
          </kbd>
        </Button>
      </DialogTrigger>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg" showCloseButton={false}>
        <DialogTitle className="sr-only">Search customers</DialogTitle>
        <DialogDescription className="sr-only">
          Search customers by name or email to jump straight to their profile.
        </DialogDescription>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search customers by name or email…"
            className="h-11 border-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-1.5">
          {trimmed.length < 2 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Type at least 2 characters to search.
            </p>
          ) : isLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              No customers match &quot;{trimmed}&quot;.
            </p>
          ) : (
            results.map((c, i) => (
              <button
                key={c.id}
                type="button"
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => select(c)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm",
                  i === activeIndex && "bg-muted",
                )}
              >
                <User className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{c.name}</span>
                  <span className="ml-1.5 text-muted-foreground">{c.email}</span>
                </span>
                {c.doNotContact && (
                  <BellOff className="size-3.5 shrink-0 text-muted-foreground" aria-label="Do not contact" />
                )}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
