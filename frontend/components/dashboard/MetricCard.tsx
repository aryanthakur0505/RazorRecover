"use client";

import { motion } from "motion/react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

export function MetricCard({
  label,
  value,
  subLabel,
  icon: Icon,
  tone = "neutral",
}: {
  label: string;
  value: string;
  subLabel?: string;
  icon: LucideIcon;
  tone?: "neutral" | "good" | "critical" | "warning";
}) {
  const toneClass = {
    neutral: "text-chart-1 bg-chart-1/10",
    good: "text-success-text bg-status-good/10",
    critical: "text-status-critical bg-status-critical/10",
    warning: "text-[#8a5a00] dark:text-status-warning bg-status-warning/10",
  }[tone];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
    >
      <Card className="gap-3 py-5 transition-shadow hover:shadow-md">
        <CardContent className="flex items-start justify-between gap-3 px-5">
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-muted-foreground">{label}</p>
            <motion.p
              key={value}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
              className="font-mono text-2xl font-semibold tracking-tight tabular-nums"
            >
              {value}
            </motion.p>
            {subLabel && <p className="text-xs text-muted-foreground">{subLabel}</p>}
          </div>
          <div className={cn("rounded-lg p-2", toneClass)}>
            <Icon className="size-5" />
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
