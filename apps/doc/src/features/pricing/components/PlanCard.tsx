// PlanCard.tsx — one plan tier.
//
// Every card carries its availability badge. These plans are published estimates for a service that does not
// bill yet, and a price table that does not say so is a promise nobody agreed to make.

import { AvailabilityBadge } from "@/components/AvailabilityBadge.tsx";
import type { Plan } from "@/content/types.ts";
import { Card } from "@leadwolf/ui";
import styles from "../pricing.module.css";

export function PlanCard({ plan }: { plan: Plan }) {
  return (
    <Card as="article">
      <h3 className={styles.planName}>{plan.name}</h3>
      <p className={styles.planPrice}>{plan.price}</p>
      <p className={styles.planCadence}>{plan.cadence}</p>
      <p className={styles.planCredits}>{plan.credits}</p>
      <p className={styles.planAudience}>{plan.audience}</p>
      <ul className={styles.planIncludes}>
        {plan.includes.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <div className={styles.planBadge}>
        <AvailabilityBadge availability={plan.availability} />
      </div>
    </Card>
  );
}
