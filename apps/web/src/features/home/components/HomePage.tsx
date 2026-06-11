// HomePage.tsx — the Home cockpit: a row of KPI StatTiles (credit balance · recent reveals · verified-data
// billing reassurance), a Recent-reveals card, and a Quick-actions card. Composes packages/ui primitives;
// data comes from useHomeSummary. Monochrome — color appears only via StatusBadge tones. Public slice component.
"use client";

import { Card, Spinner, StatTile, StatusBadge, type StatusTone } from "@leadwolf/ui";
import Link from "next/link";
import { useHomeSummary } from "../hooks/useHomeSummary";
import type { UsageReveal } from "../types";
import styles from "./HomePage.module.css";

const REVEAL_LABEL: Record<UsageReveal["revealType"], string> = {
  email: "Email",
  phone: "Phone",
  full_profile: "Full profile",
};

const REVEAL_TONE: Record<UsageReveal["revealType"], StatusTone> = {
  email: "success",
  phone: "warning",
  full_profile: "muted",
};

const dateFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dateFmt.format(d);
}

function RecentReveals({
  reveals,
  loading,
  error,
}: {
  reveals: UsageReveal[];
  loading: boolean;
  error: string | null;
}) {
  if (error) return <p className={styles.error}>{error}</p>;
  if (loading) {
    return (
      <div className={styles.loadingRow}>
        <Spinner /> Loading recent reveals…
      </div>
    );
  }
  if (reveals.length === 0) {
    return (
      <p className={styles.muted}>
        No reveals yet. Reveal a verified email or phone from Prospect and it will show up here.
      </p>
    );
  }
  return (
    <div className={styles.revealList}>
      {reveals.map((r) => (
        <div key={r.id} className={styles.revealRow}>
          <span className={styles.revealMain}>
            <StatusBadge tone={REVEAL_TONE[r.revealType]}>{REVEAL_LABEL[r.revealType]}</StatusBadge>
            <span className={styles.revealMeta}>{formatDate(r.revealedAt)}</span>
          </span>
          <span className={styles.revealCredits}>
            −{r.creditsConsumed} credit{r.creditsConsumed === 1 ? "" : "s"}
          </span>
        </div>
      ))}
    </div>
  );
}

export function HomePage() {
  const { summary, error, loading } = useHomeSummary();

  const balance = summary?.creditBalance ?? null;
  const reveals = summary?.reveals ?? [];
  const lowBalance = balance != null && balance < 50;

  return (
    <main className={styles.page}>
      <header className={styles.heading}>
        <h1 className={styles.title}>Home</h1>
        <p className={styles.subtitle}>Your workspace at a glance.</p>
      </header>

      <section className={styles.tiles}>
        <StatTile
          label="Credit balance"
          value={
            loading && balance == null ? <Spinner size={20} /> : (balance ?? "—").toLocaleString()
          }
          sublabel={
            lowBalance ? "Running low — top up to keep revealing." : "Reveal credits available"
          }
          trend={
            balance != null ? (
              <StatusBadge tone={lowBalance ? "warning" : "success"}>
                {lowBalance ? "Low" : "Healthy"}
              </StatusBadge>
            ) : undefined
          }
        />
        <StatTile
          label="Recent reveals"
          value={loading && summary == null ? <Spinner size={20} /> : reveals.length}
          sublabel="In your last 10 of activity"
        />
        <StatTile
          label="Verified-data billing"
          value="Pay per result"
          sublabel="You're only charged when a reveal returns verified data — never for a miss."
        />
      </section>

      <section className={styles.columns}>
        <Card>
          <h2 className={styles.cardTitle}>Recent reveals</h2>
          <RecentReveals reveals={reveals} loading={loading} error={error} />
        </Card>

        <Card>
          <h2 className={styles.cardTitle}>Quick actions</h2>
          <nav className={styles.actions}>
            <Link className={styles.action} href="/prospect">
              <span className={styles.actionLabel}>New search</span>
              <span className={styles.actionHint}>Find contacts & accounts</span>
            </Link>
            <Link className={styles.action} href="/prospect">
              <span className={styles.actionLabel}>Import contacts</span>
              <span className={styles.actionHint}>Upload a CSV into this workspace</span>
            </Link>
            <Link className={styles.action} href="/settings/billing">
              <span className={styles.actionLabel}>Top up credits</span>
              <span className={styles.actionHint}>Add reveal credits in Billing</span>
            </Link>
          </nav>
        </Card>
      </section>
    </main>
  );
}
