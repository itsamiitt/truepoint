// WidgetCard.tsx — the shared frame every cockpit widget uses: a Card with a consistent header (an optional
// lucide title glyph + uppercase title + optional right-aligned hint) and an async body wrapped in the State
// Kit's <StateSwitch>, so every widget renders loading/empty/error identically (04 §5). Presentation only —
// the parent supplies the resolved loading/error/empty flags and the children for the loaded state.
"use client";

import {
  Card,
  EmptyState,
  Icon,
  type IconComponent,
  LoadingState,
  StateSwitch,
} from "@leadwolf/ui";
import type { CSSProperties, ReactNode } from "react";
import styles from "./HomePage.module.css";

export function WidgetCard({
  title,
  icon,
  hint,
  loading,
  error,
  empty,
  onRetry,
  emptyIcon,
  emptyTitle,
  emptyDescription,
  emptyAction,
  skeletonRows = 4,
  skeleton,
  children,
  style,
}: {
  title: string;
  icon?: IconComponent;
  hint?: ReactNode;
  loading: boolean;
  error: string | null;
  empty: boolean;
  onRetry?: () => void;
  emptyIcon?: IconComponent;
  emptyTitle: string;
  emptyDescription?: ReactNode;
  emptyAction?: ReactNode;
  skeletonRows?: number;
  /** Override the default LoadingState skeleton (e.g. the sparkline/metric layouts). */
  skeleton?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <Card
      style={{
        background: "var(--tp-surface)",
        border: "1px solid var(--tp-hairline-2)",
        borderRadius: "var(--tp-radius-card)",
        boxShadow: "0 1px 2px rgba(17, 24, 39, 0.04)",
        ...style,
      }}
    >
      <div className={styles.cardHeader}>
        <div className={styles.cardTitleWrap}>
          {icon ? (
            <span className={styles.cardTitleIcon}>
              <Icon icon={icon} size={15} />
            </span>
          ) : null}
          <h2 className={styles.cardTitle}>{title}</h2>
        </div>
        {hint != null ? <p className={styles.cardHint}>{hint}</p> : null}
      </div>
      <StateSwitch
        loading={loading}
        error={error}
        empty={empty}
        onRetry={onRetry}
        skeleton={skeleton ?? <LoadingState rows={skeletonRows} />}
        emptyState={
          <EmptyState
            icon={emptyIcon ? <Icon icon={emptyIcon} size={22} /> : undefined}
            title={emptyTitle}
            description={emptyDescription}
            action={emptyAction}
            style={{ padding: "28px 12px" }}
          />
        }
      >
        {children}
      </StateSwitch>
    </Card>
  );
}
