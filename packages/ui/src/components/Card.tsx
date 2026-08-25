// Card.tsx — the base surface container (raised-off-white panel: --tp-surface-2 fill, hairline border,
// --radius) that frames every dashboard widget. Layout/styling only; holds no logic and fetches no data.
import type { CSSProperties, ReactNode } from "react";

export function Card({
  children,
  style,
  as: Tag = "section",
}: {
  children?: ReactNode;
  style?: CSSProperties;
  as?: "section" | "div" | "article";
}) {
  return (
    <Tag
      style={{
        background: "var(--tp-surface-2)",
        border: "1px solid var(--tp-hairline-2)",
        // The card tokens exist for the card. --tp-radius-card (14px) and --tp-shadow-card were defined for
        // the Brand Kit's "cards float" and then never applied by the component they were named after, so
        // the shipped card sat at the generic 8px --radius with no elevation at all.
        borderRadius: "var(--tp-radius-card)",
        boxShadow: "var(--tp-shadow-card)",
        padding: "var(--tp-space-5)",
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}
