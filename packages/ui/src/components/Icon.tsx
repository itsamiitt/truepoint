// Icon.tsx — the single icon wrapper. Pass any lucide-react glyph as `icon`; it renders at a consistent stroke
// + size, token-colored by the surrounding `color`. Replaces the unicode glyphs in the sidebar. Decorative by
// default (aria-hidden); pass `label` to make it a labelled graphic.
import type { ComponentType, CSSProperties, SVGProps } from "react";

/** Shape of a lucide-react icon component (size/strokeWidth + standard SVG props). */
export type IconComponent = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string }
>;

export function Icon({
  icon: Glyph,
  size = 16,
  strokeWidth = 1.75,
  className,
  style,
  label,
}: {
  icon: IconComponent;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
  label?: string;
}) {
  return (
    <Glyph
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      style={style}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
    />
  );
}
