// IntentSection.tsx — the intent-signals half of the Lead score & intent dashboard. Intent signals
// (job_change, funding_round, web_visit, … — intel.ts signalType) come from the intelligence pipeline
// (03 §6, ADR-0008) which is not wired into a reporting endpoint yet, so this renders a first-class
// "no intent signals yet" empty state. No invented signals. Presentation only.
"use client";

import { EmptyState, Icon } from "@leadwolf/ui";
import { Radar } from "lucide-react";
import styles from "../reports.module.css";

export function IntentSection() {
  return (
    <div className={styles.subPanel}>
      <h3 className={styles.subheading}>Intent signals</h3>
      <EmptyState
        icon={<Icon icon={Radar} size={28} />}
        title="No intent signals yet"
        description="Job changes, funding rounds, tech installs, and web visits will surface here once the intelligence pipeline feeds the reporting layer. Intent reporting ships post-MVP."
      />
    </div>
  );
}
