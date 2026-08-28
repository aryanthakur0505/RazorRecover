"use client";

import { useSession } from "@/components/providers/SessionProvider";
import { ErrorState } from "@/components/shared/States";
import { ShieldHalf } from "lucide-react";

export function SessionGate({ children }: { children: React.ReactNode }) {
  const { status, error, retry } = useSession();

  if (status === "loading") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3">
        <ShieldHalf className="size-8 animate-pulse text-chart-1" />
        <p className="text-sm text-muted-foreground">Connecting to RazorRecover…</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-md">
          <ErrorState
            title="Backend unavailable"
            description={error ?? "Could not establish a merchant session. Confirm the backend is running and NEXT_PUBLIC_API_URL is correct."}
            onRetry={retry}
          />
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
