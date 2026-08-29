import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DATE_RANGE_PRESETS, DateRangePreset } from "@/lib/dateGroups";

export function ListFilterBar({
  q,
  onQChange,
  placeholder,
  dateRange,
  onDateRangeChange,
}: {
  q: string;
  onQChange: (q: string) => void;
  placeholder: string;
  dateRange: DateRangePreset;
  onDateRangeChange: (preset: DateRangePreset) => void;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => onQChange(e.target.value)} placeholder={placeholder} className="pl-8" />
      </div>
      <Select value={dateRange} onValueChange={(v) => onDateRangeChange(v as DateRangePreset)}>
        <SelectTrigger className="w-full sm:w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DATE_RANGE_PRESETS.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
