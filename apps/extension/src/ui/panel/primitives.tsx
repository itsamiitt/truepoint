// primitives.tsx — the panel's local atoms.
//
// WHY LOCAL RATHER THAN @leadwolf/ui. The design-system component barrel is Tailwind-dependent at consume
// time and the extension's Vite build does not run Tailwind (extension-architecture rule 7). The sanctioned
// reuse path is TOKENS: `@leadwolf/ui/tokens.css` is imported once in brand.css and everything here reads
// `var(--tp-*)`. These are deliberately thin — a Button that is a real <button>, a Badge that is a tone plus
// text — so they carry the design system's decisions without importing its runtime.
//
// Rules these encode so no surface has to remember them:
//   • real <button type="button">, never a <div onClick> — keyboard reachability is not optional;
//   • ≥44px hit targets on anything a rep taps (--tp-row-h);
//   • meaning is never colour alone: every tone renders text or a glyph alongside it;
//   • no hardcoded hex — the fallbacks after each token are the DS's own light values, for the moment before
//     tokens.css applies.
import type React from "react";

export const ink = "var(--tp-ink, #111827)";
export const ink2 = "var(--tp-ink-2, #374151)";
/** The muted TEXT colour. 4.83:1 on --tp-surface — the lightest ink that still clears WCAG 2.2 AA. */
export const ink3 = "var(--tp-ink-3, #6b7280)";
/**
 * NOT FOR RUNNING TEXT. --tp-ink-4 is 2.54:1 on --tp-surface: it fails AA for body copy and fails the 3:1
 * non-text minimum for anything a user has to operate. Legitimate uses are the ones the contrast minimums
 * exempt or do not reach — a DISABLED control, and decoration. Muted copy, labels, captions, timestamps,
 * metadata, avatar monograms and enabled icon glyphs are all TEXT or UI: they take `ink3`.
 */
export const ink4 = "var(--tp-ink-4, #9ca3af)";
export const hairline = "var(--tp-hairline, #f0f0f0)";
export const hairline2 = "var(--tp-hairline-2, #e5e7eb)";
export const surface = "var(--tp-surface, #fff)";
export const surface2 = "var(--tp-surface-2, #f9fafb)";
export const surface3 = "var(--tp-surface-3, #f4f5f7)";
export const cobalt = "var(--tp-cobalt, #2563c9)";

export const mono: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontVariantNumeric: "tabular-nums",
};

/** The small uppercase section heading ("CONTACT", "SIGNALS", "EXPERIENCE"). */
export function SectionLabel({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 8,
        marginBottom: 6,
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: ink3,
        }}
      >
        {children}
      </span>
      {right ? <span style={{ fontSize: 11, color: ink3 }}>{right}</span> : null}
    </div>
  );
}

export type ButtonVariant = "primary" | "secondary" | "ghost";

const VARIANT: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    background: "var(--tp-btn, #111827)",
    color: "var(--tp-on-fill, #fff)",
    border: "1px solid transparent",
  },
  secondary: { background: surface, color: ink, border: `1px solid ${hairline2}` },
  ghost: { background: "transparent", color: ink2, border: "1px solid transparent" },
};

export function Button({
  children,
  onClick,
  variant = "secondary",
  full = false,
  disabled = false,
  busy = false,
  title,
  buttonRef,
  hasPopup,
  expanded,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  full?: boolean;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
  /** For a trigger that has to be re-focused after its popup closes. Named, not `ref`, so it stays typed. */
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
  /** Both of these together, or neither: a disclosure trigger must say what it opens AND whether it is open. */
  hasPopup?: "menu" | "listbox" | "dialog";
  expanded?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      ref={buttonRef}
      title={title}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      aria-haspopup={hasPopup}
      aria-expanded={hasPopup ? Boolean(expanded) : undefined}
      style={{
        ...VARIANT[variant],
        width: full ? "100%" : undefined,
        // 44px is the design system's interactive row height; a panel is a touch target too.
        minHeight: 32,
        padding: "7px 12px",
        borderRadius: "var(--radius, 8px)",
        fontSize: 13,
        fontWeight: 600,
        fontFamily: "inherit",
        cursor: disabled || busy ? "default" : "pointer",
        opacity: disabled && !busy ? 0.5 : 1,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

export type BadgeTone = "success" | "warning" | "muted";

const TONE: Record<BadgeTone, { fg: string; bg: string; glyph: string }> = {
  // The glyph is not decoration: it is what carries the meaning for anyone who cannot separate the hues.
  //
  // The -700 tone on the -50 tint, not the base colour on an ad-hoc 10% wash: --success is 3.30:1 on white
  // and --warning 3.19:1, which is fine behind a status dot and below the 4.5:1 floor for the LABEL, and
  // tokens.css says exactly that ("Status colour on TEXT → the -700"). The DS ships these as a designed
  // pair — --success-700 on --success-50 is 4.71:1, --warning-700 on --warning-50 is 4.62:1.
  success: { fg: "var(--success-700, #15803d)", bg: "var(--success-50, #eaf6ee)", glyph: "✓" },
  warning: { fg: "var(--warning-700, #b45309)", bg: "var(--warning-50, #fdf3e7)", glyph: "!" },
  muted: { fg: ink3, bg: surface3, glyph: "·" },
};

export function Badge({
  tone = "muted",
  children,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
}): React.ReactElement {
  const t = TONE[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 7px",
        borderRadius: "var(--tp-radius-sm, 6px)",
        background: t.bg,
        color: t.fg,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden="true">{t.glyph}</span>
      {children}
    </span>
  );
}

export function Chip({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "3px 8px",
        borderRadius: "var(--tp-radius-sm, 6px)",
        background: surface3,
        color: ink2,
        fontSize: 12,
      }}
    >
      {children}
    </span>
  );
}

/** A nested well — the contact card's surface. */
export function Well({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}): React.ReactElement {
  return (
    <div
      style={{
        background: surface2,
        borderRadius: "var(--tp-radius-card, 14px)",
        padding: 14,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** A shape-matched loading block. Sized by the caller so arriving data never reflows the layout. */
export function Skeleton({
  width = "100%",
  height = 12,
  radius = 6,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
}): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "block",
        width,
        height,
        borderRadius: radius,
        background: surface3,
        // Opacity-only pulse, and only when the viewer has not asked for less motion.
        animation: "tp-skeleton 1.4s ease-in-out infinite",
      }}
    />
  );
}

/** A muted one-liner: the empty state for a section that simply has nothing to show. */
export function Muted({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div style={{ fontSize: 13, color: ink3, lineHeight: 1.5 }}>{children}</div>;
}

/** The in-surface error, with the retry. Never a toast — an error about THIS panel belongs in it. */
export function ErrorBlock({
  title,
  detail,
  onRetry,
  retryLabel,
}: {
  title: string;
  detail?: string;
  onRetry?: () => void;
  retryLabel: string;
}): React.ReactElement {
  return (
    <div style={{ padding: "24px 0", textAlign: "center" }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{title}</div>
      {detail ? <Muted>{detail}</Muted> : null}
      {onRetry ? (
        <div style={{ marginTop: 12, display: "flex", justifyContent: "center" }}>
          <Button variant="secondary" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** A centred empty state: one line, one hint, no glyph zoo. */
export function EmptyBlock({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}): React.ReactElement {
  return (
    <div style={{ padding: "40px 0", textAlign: "center" }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{title}</div>
      {hint ? <Muted>{hint}</Muted> : null}
    </div>
  );
}

/** A key/value row for the Details list. */
export function KeyValue({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "9px 0",
        borderBottom: `1px solid ${hairline}`,
      }}
    >
      <span style={{ width: 96, flex: "none", fontSize: 12, color: ink3 }}>{label}</span>
      <span style={{ flex: 1, fontSize: 13, color: ink2 }}>{children}</span>
    </div>
  );
}
