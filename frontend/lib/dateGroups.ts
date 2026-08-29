/** Groups a list into "Today / Yesterday / 15 August" day-divider sections — purely a display
 *  affordance over a single flat, searchable list (not a storage split), so search/filter/sort
 *  keep working across every day at once. */

function isSameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

export function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (isSameDay(date, today)) return "Today";
  if (isSameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  });
}

/** Given items already sorted newest-first by `dateOf(item)`, returns each item paired with a
 *  divider label to render right before it — `null` when it belongs under the previous item's
 *  day (i.e. don't repeat the divider). */
export function withDayDividers<T>(items: T[], dateOf: (item: T) => string): { item: T; divider: string | null }[] {
  let lastLabel: string | null = null;
  return items.map((item) => {
    const label = dayLabel(dateOf(item));
    const divider = label === lastLabel ? null : label;
    lastLabel = label;
    return { item, divider };
  });
}

export const DATE_RANGE_PRESETS = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
] as const;

export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number]["value"];

/** Resolves a preset into `{ from, to }` ISO strings for the API — `to` is always "now" except
 *  for "all" (no filter at all). */
export function resolveDateRange(preset: DateRangePreset): { from?: string; to?: string } {
  if (preset === "all") return {};
  const now = new Date();
  const from = new Date(now);
  if (preset === "today") {
    from.setHours(0, 0, 0, 0);
  } else if (preset === "7d") {
    from.setDate(now.getDate() - 7);
  } else if (preset === "30d") {
    from.setDate(now.getDate() - 30);
  } else if (preset === "90d") {
    from.setDate(now.getDate() - 90);
  }
  return { from: from.toISOString(), to: now.toISOString() };
}
