import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

export function LoadMoreFooter({
  shown,
  total,
  hasMore,
  loading,
  onLoadMore,
}: {
  shown: number;
  total: number;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  if (total === 0) return null;
  return (
    <div className="flex flex-col items-center gap-2 pt-3">
      <p className="text-xs text-muted-foreground">
        Showing {shown.toLocaleString()} of {total.toLocaleString()}
      </p>
      {hasMore && (
        <Button variant="outline" size="sm" onClick={onLoadMore} disabled={loading}>
          {loading && <Loader2 className="size-4 animate-spin" />}
          Load More
        </Button>
      )}
    </div>
  );
}
