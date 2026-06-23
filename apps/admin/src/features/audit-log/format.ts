// format.ts — small pure presentation helpers for the Audit log area (timestamps, target/short-id display).
// Pure + DOM-free so they are unit-testable. The log is read-only; these only shape display strings.

/** A compact, locale-stable UTC timestamp (YYYY-MM-DD HH:MM:SSZ) from an ISO string; "—" when absent/bad. */
export function shortDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 19).replace("T", " ")}Z`;
}

/** First segment of a UUID (or any value) for compact display; "—" when absent. */
export function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  return value.split("-")[0] ?? value;
}

/** A `type · id` target descriptor, collapsing absent parts; "—" when there is no target at all. */
export function targetLabel(
  targetType: string | null | undefined,
  targetId: string | null | undefined,
): string {
  if (!targetType && !targetId) return "—";
  if (targetType && targetId) return `${targetType} · ${shortId(targetId)}`;
  return targetType ?? shortId(targetId);
}
