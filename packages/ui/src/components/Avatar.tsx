// Avatar.tsx — the grey-initials avatar (04 §1: no color, ever). Derives up to two initials from a name or
// email; presentation only.
import type { CSSProperties } from "react";

function initialsFrom(input: string): string {
  const cleaned = input.trim();
  if (!cleaned) return "?";
  const at = cleaned.indexOf("@");
  const base = at > 0 ? cleaned.slice(0, at) : cleaned;
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "";
  const b = parts[1]?.[0] ?? "";
  if (a && b) return (a + b).toUpperCase();
  return base.slice(0, 2).toUpperCase() || "?";
}

export function Avatar({
  name,
  size = 28,
  style,
}: {
  name: string | null | undefined;
  size?: number;
  style?: CSSProperties;
}) {
  const initials = initialsFrom(name ?? "?");
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--tp-surface-3)",
        color: "var(--tp-ink-3)",
        fontSize: Math.round(size * 0.38),
        fontWeight: 600,
        flex: "0 0 auto",
        userSelect: "none",
        ...style,
      }}
    >
      {initials}
    </span>
  );
}
