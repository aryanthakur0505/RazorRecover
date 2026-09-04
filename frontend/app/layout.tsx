import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { SessionProvider } from "@/components/providers/SessionProvider";
import { SWRProvider } from "@/components/providers/SWRProvider";
import { AppShell } from "@/components/providers/AppShell";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "RazorRecover — AI Revenue Recovery",
  description: "Detect, diagnose, and recover failed payments with guardrailed AI.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-muted/30">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <SWRProvider>
            <SessionProvider>
              <TooltipProvider>
                <AppShell>{children}</AppShell>
                <Toaster />
              </TooltipProvider>
            </SessionProvider>
          </SWRProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
