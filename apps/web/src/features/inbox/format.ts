// format.ts — a tiny relative-time formatter for the Inbox surfaces (kept local to the slice so it doesn't
// reach across into another slice's helpers). Pure; the parent passes ISO strings from the API.

/** "just now" / "5m ago" / "3h ago" / "2d ago" / a locale date for older timestamps. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMin = Math.round((Date.now() - then) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** "Due in 2d" / "Due today" / "Overdue 1d" / "" for no due date. */
export function formatDue(iso: string | null | undefined): string {
  if (!iso) return "";
  const due = new Date(iso).getTime();
  if (Number.isNaN(due)) return "";
  const days = Math.round((due - Date.now()) / 86400000);
  if (days === 0) return "Due today";
  if (days > 0) return `Due in ${days}d`;
  return `Overdue ${Math.abs(days)}d`;
}
