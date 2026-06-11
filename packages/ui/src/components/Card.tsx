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
        borderRadius: "var(--radius)",
        padding: 20,
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}
