// CompanyPage.tsx — the routed /companies/:id destination (market-intelligence MI-1,
// 07-product-surfaces §2): the AccountDetailDrawer's content promoted to a canonical URL. Composes the
// SAME prospect-slice sections the drawer renders (one implementation, no drift) + the account's
// delivered signal timeline + a Watch toggle. Sections self-hide or show honest empties while the data
// pipeline is dark. Every field is an organization fact — no personal data on this page beyond the
// People link into prospect search.
"use client";

import {
  AccountAlumniSection,
  AccountDisplacementSection,
  AccountTechnologySection,
  HeadcountSection,
  contactsHrefForCompany,
} from "@/features/prospect";
import type { MaskedAccount, TenantSignal } from "@leadwolf/types";
import { EmptyState, StateSwitch, StatusBadge, TpButton } from "@leadwolf/ui";
import Link from "next/link";
import styles from "../companies.module.css";
import { useCompany, useWatchAccount } from "../hooks/useCompany";
import { PostingsSection } from "./PostingsSection";

function show(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") return v.toLocaleString();
  return v;
}

function humanizeToken(v: string | null): string {
  if (!v) return "—";
  return v.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const d = Math.floor((Date.now() - then) / 86_400_000);
  if (d < 1) return "today";
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.fieldValue}>{value}</span>
    </div>
  );
}

function SignalsTimeline({ signals }: { signals: TenantSignal[] }) {
  if (signals.length === 0) {
    return (
      <EmptyState
        title="No signals for this company yet"
        description="Leadership, hiring and funding events appear here as they land."
      />
    );
  }
  return (
    <ul className={styles.signalList}>
      {signals.map((s) => (
        <li key={s.id} className={styles.signalItem}>
          <StatusBadge tone={s.family === "leadership" ? "warning" : "muted"}>
            {humanizeToken(s.family)}
          </StatusBadge>
          <span className={styles.signalHeadline}>{s.headline ?? humanizeToken(s.typeCode)}</span>
          <span className={styles.signalTime}>{relTime(s.observedAt)}</span>
        </li>
      ))}
    </ul>
  );
}

function Header({ account }: { account: MaskedAccount }) {
  const { watched, loading, toggling, toggle } = useWatchAccount(account.id);
  const hq = [account.hqCity, account.hqCountry].filter(Boolean).join(", ");
  return (
    <header className={styles.header}>
      <div className={styles.headerMain}>
        <h1 className={styles.name}>{account.name}</h1>
        {account.domain ? <span className={styles.domain}>{account.domain}</span> : null}
      </div>
      <div className={styles.headerActions}>
        <TpButton
          variant={watched ? "secondary" : "primary"}
          size="sm"
          onClick={toggle}
          disabled={loading || toggling}
        >
          {watched ? "Watching" : "Watch"}
        </TpButton>
        <Link href={contactsHrefForCompany(account.domain ?? account.name)}>
          <TpButton variant="ghost" size="sm">
            View {account.contactCount > 0 ? account.contactCount : ""} contacts
          </TpButton>
        </Link>
      </div>
      <div className={styles.fieldGrid}>
        <Field label="Industry" value={show(account.industry)} />
        <Field label="Headcount" value={show(account.employeeCount)} />
        <Field label="Revenue" value={show(account.revenueRange)} />
        <Field label="HQ" value={show(hq)} />
        <Field label="Funding stage" value={humanizeToken(account.fundingStage)} />
        <Field label="Founded" value={show(account.foundedYear)} />
      </div>
    </header>
  );
}

export function CompanyPage({ accountId }: { accountId: string }) {
  const { account, signals } = useCompany(accountId);

  return (
    <StateSwitch
      loading={account.isPending}
      error={account.error}
      onRetry={() => void account.refetch()}
      empty={!account.data}
      emptyState={<EmptyState title="Company not found" />}
    >
      {account.data ? (
        <section className={styles.page}>
          <Header account={account.data} />
          <div className={styles.sections}>
            <section>
              <h2 className={styles.sectionTitle}>Momentum</h2>
              <HeadcountSection accountId={accountId} />
              <PostingsSection accountId={accountId} />
              <h2 className={styles.sectionTitle}>Signals</h2>
              <StateSwitch
                loading={signals.isPending}
                error={signals.error}
                onRetry={() => void signals.refetch()}
                empty={(signals.data ?? []).length === 0}
                emptyState={
                  <EmptyState
                    title="No signals for this company yet"
                    description="Leadership, hiring and funding events appear here as they land."
                  />
                }
              >
                <SignalsTimeline signals={signals.data ?? []} />
              </StateSwitch>
            </section>
            <section>
              <h2 className={styles.sectionTitle}>Technology</h2>
              <AccountTechnologySection accountId={accountId} relationship="uses" />
              <AccountTechnologySection accountId={accountId} relationship="develops" />
              <AccountDisplacementSection accountId={accountId} />
              <AccountAlumniSection accountId={accountId} />
            </section>
          </div>
        </section>
      ) : null}
    </StateSwitch>
  );
}
