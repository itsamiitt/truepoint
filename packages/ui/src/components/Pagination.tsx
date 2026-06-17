// Pagination.tsx — a cursor-style pager (Prev/Next + a range label). We never deep-offset (09/24); the parent
// supplies hasPrev/hasNext + handlers, so this works for both cursor and page-number paging. Presentation only.
import { cn } from "../cn.ts";

export function Pagination({
  onPrev,
  onNext,
  hasPrev = false,
  hasNext = false,
  label,
  className,
}: {
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  /** e.g. "1–25 of 312". */
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn("tp-ui-pagination", className)}>
      <button
        type="button"
        className="tp-ui-btn tp-ui-btn--ghost tp-ui-btn--sm"
        onClick={onPrev}
        disabled={!hasPrev}
      >
        Previous
      </button>
      {label != null ? <span>{label}</span> : null}
      <button
        type="button"
        className="tp-ui-btn tp-ui-btn--ghost tp-ui-btn--sm"
        onClick={onNext}
        disabled={!hasNext}
      >
        Next
      </button>
    </div>
  );
}
