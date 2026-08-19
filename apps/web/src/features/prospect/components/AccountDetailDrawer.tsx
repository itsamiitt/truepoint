// AccountDetailDrawer.tsx — a read-only company record preview (the Accounts sibling of QuickViewDrawer): the
// firmographics (industry, headcount, revenue, HQ, funding/stage, founded year, ICP fit, technographics) plus a
// "View N contacts" button that asks the page to switch to the Contacts scope filtered by this account. Reuses
// the foundation Drawer + token-styled fields; the page owns selection (a null account = closed). No reveal /
// edit machinery — accounts carry no PII; the only masked dimension is the contact-rollup sub-count.
"use client";

import type { MaskedAccount } from "@leadwolf/types";
import { Avatar, Drawer, StatusBadge, TpButton, TpChip } from "@leadwolf/ui";
import { Users } from "lucide-react";
import Link from "next/link";
import { useAccountTechnologies } from "../hooks/useAccountTechnologies";
import { isNotableOrgKind, orgKindCopy } from "../orgKindCopy";
import styles from "../prospect.module.css";
import { AccountAlumniSection, AccountDisplacementSection } from "./AccountGraphSections";
import { AccountTechnologySection } from "./AccountTechnologySections";
import { HeadcountSection } from "./HeadcountSection";
import { RefreshFromSourceButton } from "./RefreshFromSourceButton";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.fieldValue}>{value}</span>
    </div>
  );
}

function humanizeToken(v: string): string {
  return v
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bSeries ([a-z])\b/i, (_m, l: string) => `Series ${l.toUpperCase()}`);
}

/** A firmographic value or em-dash; coarse enum tokens (funding/stage) are humanized. */
function show(v: string | number | null | undefined, humanize = false): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") return v.toLocaleString();
  return humanize ? humanizeToken(v) : v;
}

export function AccountDetailDrawer({
  account,
  onClose,
  onViewContacts,
}: {
  /** The previewed company; null closes the Drawer. */
  account: MaskedAccount | null;
  onClose: () => void;
  /** Switch the page to the Contacts scope filtered by this account. Omit to hide the button. */
  onViewContacts?: (account: MaskedAccount) => void;
}) {
  // The develops section already fetches this account's Layer-0 answer; reading org_kind off that shared
  // cache entry costs NOTHING extra — same query key, same request.
  const { orgKind } = useAccountTechnologies(account?.id ?? null, "develops");
  const copy = orgKindCopy(orgKind as never);
  const open = account != null;
  const hq = account ? [account.hqCity, account.hqCountry].filter(Boolean).join(", ") || "—" : "—";
  const fundingStage = account
    ? [account.fundingStage, account.companyStage]
        .filter((v): v is string => Boolean(v))
        .map(humanizeToken)
        .join(" · ") || "—"
    : "—";

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={account ? account.name : "Company"}
      width={420}
      footer={
        account ? (
          <div className={styles.drawerActions}>
            {onViewContacts ? (
              <TpButton
                variant="primary"
                size="sm"
                leftIcon={<Users size={15} />}
                onClick={() => onViewContacts(account)}
              >
                View {account.contactCount.toLocaleString()}{" "}
                {account.contactCount === 1 ? "contact" : "contacts"}
              </TpButton>
            ) : null}
            {/* linkedin-source-ingestion §account lane: 202-queued company refresh; the server 422s
                honestly when the account has no LinkedIn identity, and 400s while the lane is dark. */}
            <RefreshFromSourceButton entity="account" id={account.id} />
            {/* MI-1: the drawer is the in-search preview; the canonical, shareable surface is the page. */}
            <Link href={`/companies/${account.id}`}>
              <TpButton variant="ghost" size="sm">
                Open company page
              </TpButton>
            </Link>
          </div>
        ) : undefined
      }
    >
      {account ? (
        <div className={styles.detail}>
          <div className={styles.identity}>
            <Avatar name={account.name} size={44} />
            <div className={styles.identityMeta}>
              <span className={styles.identityName}>{account.name}</span>
              <span className={styles.identitySub}>
                {account.domain ?? "—"}
                {isNotableOrgKind(orgKind as never) ? ` · ${copy.noun}` : ""}
              </span>
            </div>
          </div>

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>{copy.attributesTitle}</h3>
              <StatusBadge tone={account.revealedContactCount > 0 ? "success" : "muted"}>
                {account.contactCount.toLocaleString()} contacts
              </StatusBadge>
            </div>
            <div className={styles.fieldGrid}>
              <Field label="Industry" value={show(account.industry)} />
              <Field label="Sub-industry" value={show(account.subIndustry)} />
              <Field label="Headcount" value={show(account.employeeCount)} />
              <Field label="Revenue" value={show(account.revenueRange)} />
              <Field label="Funding / Stage" value={fundingStage} />
              <Field label="Founded" value={show(account.foundedYear)} />
              <Field label="HQ" value={hq} />
              <Field
                label="ICP fit"
                value={account.icpFitScore != null ? `${account.icpFitScore}/100` : "—"}
              />
            </div>
          </section>

          {/* The Layer-0 traversal (0108): two sections, never one merged list — "what they build" and
              "what they run" are different facts from different tables. Each fetches independently, so a
              slow or empty answer on one side never blanks the other. Both render nothing until ER has
              bridged this account to the shared graph. */}
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Headcount trend</h3>
            </div>
            {/* The 0114 monthly series; deltas derived client-side. Empty-states until a company refresh
                lands the series. */}
            <HeadcountSection accountId={account.id} />
          </section>

          <AccountTechnologySection accountId={account.id} relationship="develops" />
          <AccountTechnologySection accountId={account.id} relationship="uses" />
          {/* Conditional siblings: each renders NOTHING unless it has something to report — a permanent
              empty "Recently dropped" panel on every account is noise, and "0 alumni" on a company is a
              nonsense answer rather than an empty one. */}
          <AccountDisplacementSection accountId={account.id} />
          <AccountAlumniSection accountId={account.id} />

          {account.technologies.length > 0 ? (
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                {/* Deliberately NOT called "Technographics" any more. This list is the workspace's own
                    signal rollup (intent_signals → accounts.technologies), which is inference, not
                    detection — the detected stack is the "Runs" section above, and giving both the same
                    name is what made them look interchangeable. */}
                <h3 className={styles.sectionTitle}>Signals from your workspace</h3>
              </div>
              <div className={styles.chipWrap}>
                {account.technologies.map((t) => (
                  <TpChip key={t}>{humanizeToken(t)}</TpChip>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}
