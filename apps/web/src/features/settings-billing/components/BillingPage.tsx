// BillingPage.tsx — the Billing & Credits surface (12 §4): a credit-balance card with a (post-MVP) Stripe
// top-up placeholder, the transparent-billing reassurance, and the itemized usage history. This is the
// feature's public component, rendered by the thin (shell)/settings/billing route. Presentation + view
// state only — balance/usage load via useBilling → api.
"use client";

import styles from "../billing.module.css";
import { useBilling } from "../hooks/useBilling";
import { UsageTable } from "./UsageTable";

export function BillingPage() {
  const { balance, usage, error, loading } = useBilling();

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Billing & Credits</h1>
        <p className={styles.subtitle}>
          Your shared credit pool, what it&apos;s been spent on, and how top-ups work.
        </p>
      </header>

      {error && <p className={styles.error}>{error}</p>}

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Credit balance</h2>
        </div>

        <div className={styles.balanceRow}>
          {loading ? (
            <div className={styles.balanceSkeleton} aria-hidden="true" />
          ) : (
            <div>
              <span className={styles.balanceNumber}>{(balance ?? 0).toLocaleString()}</span>
              <span className={styles.balanceUnit}>credits available</span>
            </div>
          )}

          <span className={styles.topUp}>
            <button
              type="button"
              className={styles.topUpButton}
              disabled
              aria-describedby="topup-hint"
            >
              Top up
            </button>
            <span role="tooltip" id="topup-hint" className={styles.tooltip}>
              Top-up via Stripe — coming soon
            </span>
          </span>
        </div>

        <p className={styles.note}>
          <span className={styles.noteDot} aria-hidden="true" />
          <span>You&apos;re only charged for verified data; bounces are credited back.</span>
        </p>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Usage history</h2>
        </div>
        {loading ? <p className={styles.muted}>Loading usage…</p> : <UsageTable reveals={usage} />}
      </section>
    </div>
  );
}
