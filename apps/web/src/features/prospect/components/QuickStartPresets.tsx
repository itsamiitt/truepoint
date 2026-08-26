// QuickStartPresets.tsx — the "Try:" row under a first-run empty grid (24 §2 "preset bundles"; decisions.md
// 2026-08-25). Each chip applies a prepared query — enum-backed, so it returns rows even on a young database
// — which is how a brand-new user learns what a filter does: by seeing one applied.
"use client";

import type { ContactQuery } from "@leadwolf/types";
import { TpChip } from "@leadwolf/ui";
import { QUICK_START_PRESETS } from "../filterGroups";
import styles from "../prospect.module.css";

export function QuickStartPresets({ onApply }: { onApply: (query: ContactQuery) => void }) {
  return (
    <div className={styles.presets}>
      <span className={styles.presetsLabel}>Try:</span>
      {QUICK_START_PRESETS.map((p) => (
        <TpChip key={p.id} onClick={() => onApply(p.query)}>
          {p.label}
        </TpChip>
      ))}
    </div>
  );
}
