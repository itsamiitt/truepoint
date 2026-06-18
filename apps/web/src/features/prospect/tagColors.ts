// tagColors.ts — the single map from a tag's brand PALETTE KEY (stored in the DB / @leadwolf/types tagColor
// enum) to the --tp-* token the dot/chip renders. The API never ships raw hex; the web app owns the
// key→token mapping so the monochrome brand system + theming stay authoritative (04 §2/§3, brand identity).
// Keep TAG_COLOR_OPTIONS in lockstep with the @leadwolf/types `tagColor` enum.

import type { TagColor } from "@leadwolf/types";

/** Palette key → the CSS custom property the tag dot is filled with. Neutral uses the muted ink token. */
export const TAG_COLOR_VAR: Record<TagColor, string> = {
  neutral: "var(--tp-ink-4)",
  accent: "var(--accent)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  info: "var(--tp-cobalt)",
};

/** Human label per palette key — used by the color picker in the tag editor. */
export const TAG_COLOR_LABELS: Record<TagColor, string> = {
  neutral: "Neutral",
  accent: "Accent",
  success: "Success",
  warning: "Warning",
  danger: "Danger",
  info: "Info",
};

/** The ordered options the color swatch picker renders (matches the @leadwolf/types tagColor enum order). */
export const TAG_COLOR_OPTIONS: TagColor[] = [
  "neutral",
  "accent",
  "success",
  "warning",
  "danger",
  "info",
];

/** Resolve a stored color key (possibly an unknown legacy value) to a token, falling back to neutral. */
export function tagColorVar(color: string): string {
  return TAG_COLOR_VAR[color as TagColor] ?? TAG_COLOR_VAR.neutral;
}
