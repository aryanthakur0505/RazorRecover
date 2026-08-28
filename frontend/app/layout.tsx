import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { SessionProvider } from "@/components/providers/SessionProvider";
import { SWRProvider } from "@/components/providers/SWRProvider";
import { SessionGate } from "@/components/providers/SessionGate";
import { NavBar } from "@/components/shared/NavBar";

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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-muted/30">
        <SWRProvider>
          <SessionProvider>
            <TooltipProvider>
              <SessionGate>
                <NavBar />
                <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
                  {children}
                </main>
              </SessionGate>
              <Toaster />
            </TooltipProvider>
          </SessionProvider>
        </SWRProvider>
      </body>
    </html>
  );
}
