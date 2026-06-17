// state.tsx — the standard State Kit. Every async surface renders empty/loading/error through these (plus the
// declarative <StateSwitch> wrapper) so the four states look identical everywhere — the biggest consistency fix
// in the redesign. Pure presentation; inline-token styled with one shared shimmer class from primitives.css.
import type { CSSProperties, ReactNode } from "react";

/** A single shimmering placeholder block (uses the tp-skeleton keyframe — opacity-only, reduced-motion-safe). */
export function Skeleton({
  width = "100%",
  height = 12,
  radius = "var(--tp-radius-sm)",
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden
      style={{
        display: "block",
        width,
        height,
        borderRadius: radius,
        background: "var(--tp-surface-3)",
        animation: "tp-skeleton 1.4s var(--tp-ease) infinite",
        ...style,
      }}
    />
  );
}

/** A column of skeleton rows — the default loading body for cards and lists. */
export function LoadingState({
  rows = 4,
  label = "Loading",
  style,
}: {
  rows?: number;
  label?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      style={{ display: "flex", flexDirection: "column", gap: 12, padding: "4px 0", ...style }}
    >
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows have no stable id
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Skeleton width={28} height={28} radius="50%" />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
            <Skeleton width={`${70 - i * 6}%`} height={11} />
            <Skeleton width={`${45 - i * 4}%`} height={9} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The quiet empty state (04 §5): one muted glyph max, a title, an optional description + single action. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  style,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        gap: 8,
        padding: "40px 24px",
        color: "var(--tp-ink-3)",
        ...style,
      }}
    >
      {icon != null ? (
        <span
          aria-hidden
          style={{ color: "var(--tp-ink-4)", display: "inline-flex", marginBottom: 4 }}
        >
          {icon}
        </span>
      ) : null}
      <div style={{ color: "var(--tp-ink)", fontSize: 14, fontWeight: 600 }}>{title}</div>
      {description != null ? (
        <div style={{ fontSize: 13, lineHeight: 1.5, maxWidth: 380 }}>{description}</div>
      ) : null}
      {action != null ? <div style={{ marginTop: 8 }}>{action}</div> : null}
    </div>
  );
}

/** The error state — a calm message + optional retry. Replaces the bare red-text errors hand-rolled per slice. */
export function ErrorState({
  title = "Something went wrong",
  detail,
  onRetry,
  retryLabel = "Try again",
  style,
}: {
  title?: ReactNode;
  detail?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        gap: 8,
        padding: "40px 24px",
        ...style,
      }}
    >
      <div style={{ color: "var(--tp-ink)", fontSize: 14, fontWeight: 600 }}>{title}</div>
      {detail != null ? (
        <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--tp-ink-3)", maxWidth: 380 }}>
          {detail}
        </div>
      ) : null}
      {onRetry != null ? (
        <button
          type="button"
          onClick={onRetry}
          className="tp-ui-btn tp-ui-btn--ghost tp-ui-btn--sm"
          style={{ marginTop: 8 }}
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

/** Declarative async wrapper — renders one of error/loading/empty/children so a feature never re-implements the
 *  `error ? … : loading ? … : empty ? … : content` ladder. Precedence: error → loading → empty → children. */
export function StateSwitch({
  loading,
  error,
  empty,
  onRetry,
  skeleton,
  emptyState,
  errorState,
  children,
}: {
  loading?: boolean;
  /** Truthy when the load failed; an Error/string is surfaced as the detail. */
  error?: unknown;
  empty?: boolean;
  onRetry?: () => void;
  /** Override the default loading body. */
  skeleton?: ReactNode;
  /** The empty body (e.g. an <EmptyState/>); shown when `empty` is true. */
  emptyState?: ReactNode;
  /** Override the default error body. */
  errorState?: ReactNode;
  children: ReactNode;
}) {
  if (error) {
    if (errorState !== undefined) return <>{errorState}</>;
    const detail =
      error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
    return <ErrorState detail={detail} onRetry={onRetry} />;
  }
  if (loading) return <>{skeleton ?? <LoadingState />}</>;
  if (empty) return <>{emptyState ?? <EmptyState title="Nothing here yet" />}</>;
  return <>{children}</>;
}
