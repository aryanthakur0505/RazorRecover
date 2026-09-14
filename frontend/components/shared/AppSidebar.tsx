"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import {
  LayoutDashboard,
  ListChecks,
  ShieldCheck,
  ShieldHalf,
  CalendarClock,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const LINKS = [
  { href: "/", label: "Command Center", icon: LayoutDashboard },
  { href: "/operations", label: "Recovery Operations", icon: ListChecks },
  { href: "/plans", label: "EMI & Promises", icon: CalendarClock },
  { href: "/policies", label: "Policies & Audit", icon: ShieldCheck },
];

const STORAGE_KEY = "razorrecover:sidebar-collapsed";

// The collapsed/expanded preference lives in localStorage, so it's read through
// useSyncExternalStore rather than useState+useEffect — that gets the persisted value on the very
// first client render (no expanded-then-collapsed flash) and avoids setting state from inside an
// effect. `listeners` covers same-tab toggles; the native `storage` event only fires cross-tab.
const listeners = new Set<() => void>();

function subscribe(callback: () => void) {
  listeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}

function getCollapsedSnapshot() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function getCollapsedServerSnapshot() {
  return false;
}

function setCollapsedPersisted(value: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    // localStorage unavailable (private mode, etc.) — collapse state just won't persist.
  }
  listeners.forEach((cb) => cb());
}

/** Shared nav-link list, reused by the desktop rail and the mobile sheet in Topbar. */
export function SidebarLinks({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <>
      {LINKS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href;
        const link = (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
              collapsed && "justify-center px-0",
              active
                ? "bg-sidebar-primary text-sidebar-primary-foreground"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            )}
          >
            <Icon className="size-4.5 shrink-0" />
            {!collapsed && <span className="truncate">{label}</span>}
          </Link>
        );

        if (!collapsed) return link;

        return (
          <Tooltip key={href}>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            <TooltipContent side="right">{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </>
  );
}

/** Desktop collapsible left sidebar. Hidden below `md`; Topbar's Sheet covers mobile nav instead. */
export function AppSidebar() {
  const collapsed = useSyncExternalStore(subscribe, getCollapsedSnapshot, getCollapsedServerSnapshot);

  function toggle() {
    setCollapsedPersisted(!collapsed);
  }

  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-150 md:flex print:hidden",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div
        className={cn(
          "flex h-14 items-center gap-2 border-b border-sidebar-border px-4 font-heading font-semibold",
          collapsed && "justify-center px-0",
        )}
      >
        <ShieldHalf className="size-5 shrink-0 text-chart-1" />
        {!collapsed && <span className="truncate">RazorRecover</span>}
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
        <SidebarLinks collapsed={collapsed} />
      </nav>

      <div className="border-t border-sidebar-border p-2">
        <Button
          variant="ghost"
          size={collapsed ? "icon-sm" : "sm"}
          className={cn("w-full text-sidebar-foreground/70", !collapsed && "justify-start gap-2")}
          onClick={toggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
          {!collapsed && <span>Collapse</span>}
        </Button>
      </div>
    </aside>
  );
}
