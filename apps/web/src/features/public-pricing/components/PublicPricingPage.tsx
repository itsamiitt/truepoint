// PublicPricingPage.tsx — the PUBLIC, unauthenticated transparent pricing surface (ADR-0012). Renders the
// active plan tiers + credit packs from the public catalog, with USD pricing, the no-lock-in / no-expiry
// reassurance, and a "Get started" CTA that routes through the app entry (the AppShell sends a logged-out
// visitor to sign-in). NEVER reads a token, tenant, or balance. Four-state via StateSwitch; semantic heading
// hierarchy + discernible CTA text for WCAG 2.2 AA. Plan credit allotments are intentionally NOT advertised:
// plan assignment grants no credits today (the monthly-grant job is unbuilt) — packs are the real mechanism.
"use client";

import type { PublicPlan } from "@leadwolf/types";
import { Card, EmptyState, StateSwitch, StatusBadge } from "@leadwolf/ui";
import { Check } from "lucide-react";
import { usePublicPricing } from "../hooks/usePublicPricing";
import styles from "../public-pricing.module.css";

// App entry — an unauthenticated visitor who clicks through is routed to sign-in by the AppShell auth gate.
const GET_STARTED_HREF = "/";

function formatUSD(cents: number): string {
  const dollars = cents / 100;
  return dollars % 1 === 0
    ? `$${dollars.toLocaleString()}`
    : `$${dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function humanizeFeature(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function enabledFeatures(plan: PublicPlan): string[] {
  return Object.entries(plan.features)
    .filter(([, on]) => on)
    .map(([k]) => humanizeFeature(k));
}

function workspaceLabel(limit: number | null): string {
  if (limit == null) return "Unlimited workspaces";
  return `${limit.toLocaleString()} workspace${limit === 1 ? "" : "s"}`;
}

export function PublicPricingPage() {
  const { plans, packs, error, loading, reload } = usePublicPricing();
  const isEmpty = plans.length === 0 && packs.length === 0;

  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <h1 className={styles.title}>Simple, transparent pricing</h1>
        <p className={styles.lede}>
          Pay for verified data, not promises. Credits never expire, there&apos;s no lock-in, and
          you can cancel anytime. Prices in USD.
        </p>
      </header>

      <StateSwitch loading={loading} error={error} onRetry={() => void reload()}>
        {isEmpty ? (
          <EmptyState
            title="Pricing is being finalized"
            description="Our plans and credit packs will appear here shortly. Check back soon."
          />
        ) : (
          <div className={styles.sections}>
            {plans.length > 0 && (
              <section aria-labelledby="plans-heading">
                <h2 id="plans-heading" className={styles.sectionTitle}>
                  Plans
                </h2>
                <div className={styles.planGrid}>
                  {plans.map((plan) => {
                    const features = enabledFeatures(plan);
                    return (
                      <Card key={plan.key} style={{ padding: 24 }}>
                        <div className={styles.planCard}>
                          <h3 className={styles.planName}>{plan.name}</h3>
                          <p className={styles.planMeta}>
                            {plan.seatLimit.toLocaleString()} seat{plan.seatLimit === 1 ? "" : "s"}{" "}
                            · {workspaceLabel(plan.workspaceLimit)}
                          </p>
                          <ul className={styles.featureList}>
                            {features.map((f) => (
                              <li key={f} className={styles.featureItem}>
                                <Check size={15} aria-hidden className={styles.featureCheck} />
                                <span>{f}</span>
                              </li>
                            ))}
                            {features.length === 0 && (
                              <li className={styles.featureMuted}>Core prospecting included</li>
                            )}
                          </ul>
                          <a className={styles.cta} href={GET_STARTED_HREF}>
                            Get started
                          </a>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              </section>
            )}

            <section aria-labelledby="credits-heading">
              <h2 id="credits-heading" className={styles.sectionTitle}>
                Credit packs
              </h2>
              <p className={styles.sectionLede}>
                Top up your shared credit pool anytime. One credit reveals one contact field;
                you&apos;re only charged for verified results.
              </p>
              {packs.length > 0 ? (
                <div className={styles.packGrid}>
                  {packs.map((pack) => (
                    <Card key={pack.key} style={{ padding: 20 }}>
                      <div className={styles.packCard}>
                        <div className={styles.packCredits}>
                          {pack.credits.toLocaleString()}
                          <span className={styles.packCreditsUnit}>credits</span>
                        </div>
                        <div className={styles.packName}>{pack.name}</div>
                        <div className={styles.packPrice}>
                          {formatUSD(pack.priceCents)}{" "}
                          <StatusBadge tone="muted">{pack.currency}</StatusBadge>
                        </div>
                        <a className={styles.ctaGhost} href={GET_STARTED_HREF}>
                          Get started
                        </a>
                      </div>
                    </Card>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="Credit packs coming soon"
                  description="Self-serve top-ups will be available here shortly."
                />
              )}
            </section>
          </div>
        )}
      </StateSwitch>

      <footer className={styles.footer}>
        <span className={styles.footDot} aria-hidden="true" />
        <span>
          Transparent by design: credits never expire, no auto-renewal traps, and your data is never
          held hostage. <a href={GET_STARTED_HREF}>Sign in</a> to manage billing.
        </span>
      </footer>
    </main>
  );
}
