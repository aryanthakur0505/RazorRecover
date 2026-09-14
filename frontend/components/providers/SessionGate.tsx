"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/components/providers/SessionProvider";
import { ErrorState } from "@/components/shared/States";
import { ShieldHalf } from "lucide-react";

export function SessionGate({ children }: { children: React.ReactNode }) {
  const { status, error, retry } = useSession();
  const router = useRouter();

  // A navigation side effect (not state), so it stays in an effect rather than the render-time
  // adjustment pattern used elsewhere in this app for pure state resets.
  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace("/login");
    }
  }, [status, router]);

  if (status === "loading" || status === "unauthenticated") {
    // Same loading treatment for "unauthenticated" as "loading" — the redirect above fires
    // immediately, so this is only ever on screen for the one render before it lands on /login.
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
            description={error ?? "Could not reach the RazorRecover backend. Confirm it's running and NEXT_PUBLIC_API_URL is correct."}
            onRetry={retry}
          />
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
