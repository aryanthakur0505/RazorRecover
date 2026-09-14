"use client";

import { usePathname } from "next/navigation";
import { SessionGate } from "@/components/providers/SessionGate";
import { AppSidebar } from "@/components/shared/AppSidebar";
import { Topbar } from "@/components/shared/Topbar";

/**
 * `/offer/[id]` is the link a real CUSTOMER opens — no merchant session, no reason to ever see
 * the merchant's sidebar/topbar or wait on SessionGate (which exists to confirm a *merchant*
 * session is ready, not something a customer has or needs). Everything else in the app is the
 * merchant-facing tool and keeps the normal shell. This is a pathname check rather than a route
 * group split so moving pages around isn't required — the existing app/operations, app/plans,
 * etc. are untouched.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublicCustomerPage = pathname?.startsWith("/offer/");

  if (isPublicCustomerPage) {
    return <>{children}</>;
  }

  return (
    <SessionGate>
      <div className="flex min-h-screen w-full">
        <AppSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
        </div>
      </div>
    </SessionGate>
  );
}
