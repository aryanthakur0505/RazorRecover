"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import { useTheme } from "next-themes";
import { Menu, ShieldHalf, Sun, Moon, LogOut, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSession } from "@/components/providers/SessionProvider";
import { CommandPalette } from "@/components/shared/CommandPalette";
import { SidebarLinks } from "@/components/shared/AppSidebar";

const TITLES: { match: (path: string) => boolean; label: string }[] = [
  { match: (p) => p === "/", label: "Command Center" },
  { match: (p) => p === "/operations", label: "Recovery Operations" },
  { match: (p) => p === "/plans", label: "EMI & Promises" },
  { match: (p) => p.startsWith("/plans/"), label: "Plan Detail" },
  { match: (p) => p === "/policies", label: "Policies & Audit" },
  { match: (p) => p.startsWith("/customers/"), label: "Customer Profile" },
];

function pageTitle(pathname: string) {
  return TITLES.find(({ match }) => match(pathname))?.label ?? "RazorRecover";
}

function ThemeToggle() {
  // `resolvedTheme` is undefined until next-themes has mounted on the client, so it already
  // renders the same (light/Moon) icon on the server and the first client paint without a
  // separate mounted flag — no effect needed to avoid a hydration mismatch.
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Button
      variant="outline"
      size="icon"
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      {resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

function MerchantMenu() {
  const { merchantName } = useSession();
  const initial = merchantName?.trim()?.[0]?.toUpperCase() ?? "M";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="gap-2 px-1.5 sm:px-2">
          <Avatar className="size-6">
            <AvatarFallback>{initial}</AvatarFallback>
          </Avatar>
          <span className="hidden max-w-32 truncate text-sm text-muted-foreground sm:inline">
            {merchantName ?? "Merchant"}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="truncate">{merchantName ?? "Merchant"}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>
          <User />
          Account
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Topbar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-6 print:hidden">
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetTrigger asChild>
          <Button variant="outline" size="icon" className="md:hidden">
            <Menu className="size-4" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">RazorRecover navigation menu</SheetDescription>
          <div className="flex h-14 items-center gap-2 border-b px-4 font-heading font-semibold">
            <ShieldHalf className="size-5 text-chart-1" />
            RazorRecover
          </div>
          <nav className="flex flex-col gap-1 p-3">
            <SidebarLinks onNavigate={() => setMobileOpen(false)} />
          </nav>
        </SheetContent>
      </Sheet>

      <h1 className="font-heading text-sm font-semibold sm:text-base">{pageTitle(pathname ?? "/")}</h1>

      <div className="ml-auto flex items-center gap-2 sm:gap-3">
        <CommandPalette />
        <ThemeToggle />
        <MerchantMenu />
      </div>
    </header>
  );
}
