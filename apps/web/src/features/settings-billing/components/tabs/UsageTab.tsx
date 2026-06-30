// UsageTab.tsx — the billing hub's Usage tab: the itemized credit-usage history on the foundation DataTable
// with a quiet empty state. Pure presentation; the reveal list comes from useBilling via the parent. (Credit-
// history pagination, filtering and CSV export land in a follow-up that gives this tab its own data hook.)
"use client";

import { Card, EmptyState, StateSwitch } from "@leadwolf/ui";
import styles from "../../billing.module.css";
import type { UsageReveal } from "../../types";
import { UsageTable } from "../UsageTable";

export function UsageTab({ usage }: { usage: UsageReveal[] }) {
  return (
    <Card style={{ padding: 24 }}>
      <div className={styles.cardHead}>
        <span className={styles.cardLabel}>Usage history</span>
      </div>
      <StateSwitch
        empty={usage.length === 0}
        emptyState={
          <EmptyState
            title="No reveals yet"
            description="When you reveal a contact, each charge shows up here — fully itemized."
          />
        }
      >
        <UsageTable reveals={usage} />
      </StateSwitch>
    </Card>
  );
}
