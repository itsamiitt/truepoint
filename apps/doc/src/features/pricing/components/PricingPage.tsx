// PricingPage.tsx — the published price list, per-action first and plans second.
//
// Per-action cost leads because that is what a developer models before they care which tier they land in.
// The section on what a credit is not is deliberate and non-negotiable: a credit here is bought, and it is
// never something a contribution earns (CLAUDE.md rule 7; content/pricing.ts carries the full reasoning).

import { Note } from "@/components/Note.tsx";
import { PageIntro } from "@/components/PageIntro.tsx";
import { ReferenceTable } from "@/components/ReferenceTable.tsx";
import intro from "@/components/page-intro.module.css";
import {
  CREDIT_ACTIONS,
  CREDIT_UNIT_NOTE,
  PLANS,
  PRICING_REVIEWED,
  ROLLOVER_NOTE,
} from "@/content/pricing.ts";
import { PageContainer } from "@leadwolf/ui";
import styles from "../pricing.module.css";
import { PlanCard } from "./PlanCard.tsx";

const ACTION_ROWS = CREDIT_ACTIONS.map((action) => [
  action.action,
  action.credits === "free" ? "Free" : String(action.credits),
  action.note,
]);

export function PricingPage() {
  return (
    <PageContainer width="default">
      <PageIntro
        eyebrow="Pricing"
        title="What a call costs, in full."
        lede="Every per-action price and every self-serve plan is on this page. There is no demo wall below the enterprise tier, and nothing here is quote-only."
      />

      <h2 className={intro.sectionTitle}>Per action</h2>
      <p className={styles.reviewed}>Figures last reviewed {PRICING_REVIEWED}</p>
      <p className={intro.sectionNote}>{CREDIT_UNIT_NOTE}</p>
      <ReferenceTable headers={["Action", "Credits", "Why"]} rows={ACTION_ROWS} />

      <div style={{ marginTop: "var(--tp-space-5)" }}>
        <Note tone="info">
          You are charged when data comes back and not otherwise. A no-match, a rate limit and an
          upstream failure all cost nothing, which means our coverage gaps show up in our match rate
          rather than on your invoice.
        </Note>
      </div>

      <h2 className={intro.sectionTitle}>Plans</h2>
      <p className={intro.sectionNote}>{ROLLOVER_NOTE}</p>
      <div className={styles.planGrid}>
        {PLANS.map((plan) => (
          <PlanCard key={plan.slug} plan={plan} />
        ))}
      </div>

      <h2 className={intro.sectionTitle}>What a credit is, and is not</h2>
      <p className={intro.sectionNote}>
        A credit is a unit you buy and spend on a successful call. That is the whole of it. Credits
        are not earned, not awarded, and not something any contribution, referral or activity can
        accrue — there is no points balance to farm anywhere in TruePoint, by design. If you
        contribute corrections through the TruePoint app, what that affects is your access tier,
        described on <a href="https://app.truepoint.in">app.truepoint.in</a>, and never a credit
        balance.
      </p>

      <h2 className={intro.sectionTitle}>Datasets are priced separately</h2>
      <p className={intro.sectionNote}>
        Packaged flat-file datasets are a fixed monthly price per dataset rather than a credit
        spend, because you are buying a refreshed file rather than making calls. Prices are on each
        dataset&rsquo;s page.
      </p>
    </PageContainer>
  );
}
