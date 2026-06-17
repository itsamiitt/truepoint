// ReportsPage.tsx — the Reports destination (11 §4.5 MVP slice): a Tabs dashboard switcher over six sections
// (Pipeline funnel · Credit usage · Sending & deliverability · Team activity · Data health · Lead score &
// intent). A shared date-range + member filter row drives the three dashboards composed from live data; the
// two without a backend yet render first-class empty states. Each dashboard has an Export CSV action. The
// ClickHouse /reports/* pipeline (ADR-0010) is post-MVP. Public slice component.
"use client";

import { Combobox, Icon, Tabs, TpButton, useToast } from "@leadwolf/ui";
import { Download, RotateCw } from "lucide-react";
import { useState } from "react";
import { downloadCsv } from "../api";
import { RANGE_OPTIONS, type RangeId, useReports } from "../hooks/useReports";
import styles from "../reports.module.css";
import type { DashboardId } from "../types";
import { CreditUsageSection } from "./CreditUsageSection";
import { DataHealthSection } from "./DataHealthSection";
import { DeliverabilitySection } from "./DeliverabilitySection";
import { FunnelSection } from "./FunnelSection";
import { LeadScoreSection } from "./LeadScoreSection";
import { TeamActivitySection } from "./TeamActivitySection";

const TABS: { value: DashboardId; label: string }[] = [
  { value: "funnel", label: "Pipeline funnel" },
  { value: "credits", label: "Credit usage" },
  { value: "deliverability", label: "Sending & deliverability" },
  { value: "team", label: "Team activity" },
  { value: "health", label: "Data health" },
  { value: "score", label: "Lead score & intent" },
];

const DASHBOARD_TITLE: Record<DashboardId, string> = {
  funnel: "Pipeline funnel",
  credits: "Credit usage",
  deliverability: "Sending & deliverability",
  team: "Team activity",
  health: "Data health",
  score: "Lead score & intent",
};

export function ReportsPage() {
  const {
    balance,
    credit,
    funnel,
    health,
    team,
    memberOptions,
    range,
    setRange,
    member,
    setMember,
    error,
    loading,
    reload,
  } = useReports();
  const { success, toast } = useToast();
  const [tab, setTab] = useState<DashboardId>("funnel");

  const memberCombo = [{ value: "all", label: "All members" }, ...memberOptions];

  // Export CSV per dashboard — PII-free rollup rows only. Dashboards without a data source toast "Coming soon".
  function handleExport() {
    const ts = new Date().toISOString().slice(0, 10);
    if (tab === "credits" && credit && credit.byType.length > 0) {
      downloadCsv(
        `credit-usage-${ts}.csv`,
        ["Reveal type", "Reveals", "Credits"],
        credit.byType.map((r) => [r.label, r.reveals, r.credits]),
      );
      success("Export ready", "Credit usage CSV downloaded.");
      return;
    }
    if (tab === "team" && team && team.rows.length > 0) {
      downloadCsv(
        `team-activity-${ts}.csv`,
        ["Member", "Revealed", "Engaged", "Credits"],
        team.rows.map((r) => [r.label, r.revealed, r.engaged, r.credits]),
      );
      success("Export ready", "Team activity CSV downloaded.");
      return;
    }
    if (tab === "funnel" && funnel && funnel.total > 0) {
      downloadCsv(
        `pipeline-funnel-${ts}.csv`,
        ["Stage", "Contacts", "Conversion %"],
        [...funnel.primary, ...funnel.secondary].map((s) => [s.label, s.count, s.conversionPct]),
      );
      success("Export ready", "Pipeline funnel CSV downloaded.");
      return;
    }
    if (tab === "health" && health && health.total > 0) {
      downloadCsv(
        `data-health-${ts}.csv`,
        ["Email status", "Contacts", "Share %"],
        health.rows.map((r) => [r.label, r.count, r.pct]),
      );
      success("Export ready", "Data health CSV downloaded.");
      return;
    }
    toast({ tone: "default", title: "Coming soon", description: "Nothing to export for this dashboard yet." });
  }

  function notifyConnectSoon() {
    toast({
      tone: "default",
      title: "Coming soon",
      description: "Mailbox connection and send analytics ship post-MVP.",
    });
  }

  return (
    <main className={styles.page}>
      <header className={styles.heading}>
        <h1 className={styles.title}>Reports</h1>
        <p className={styles.subtitle}>
          Pipeline, spend, deliverability, team, and data health for this workspace.
        </p>
      </header>

      <div className={styles.tabsRow}>
        <Tabs
          items={TABS}
          value={tab}
          onChange={(v) => setTab(v as DashboardId)}
          aria-label="Report dashboards"
        />
      </div>

      <div className={styles.filters}>
        <div className={styles.filterControls}>
          <label className={styles.filterField}>
            <span className={styles.filterLabel}>Date range</span>
            <Combobox
              options={RANGE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              value={range}
              onChange={(v) => setRange(v as RangeId)}
            />
          </label>
          <label className={styles.filterField}>
            <span className={styles.filterLabel}>Member</span>
            <Combobox
              options={memberCombo}
              value={member}
              onChange={setMember}
              placeholder="All members"
            />
          </label>
        </div>
        <div className={styles.filterActions}>
          <TpButton
            variant="ghost"
            size="sm"
            leftIcon={<Icon icon={RotateCw} size={15} />}
            onClick={() => void reload()}
            loading={loading}
          >
            Refresh
          </TpButton>
          <TpButton
            variant="secondary"
            size="sm"
            leftIcon={<Icon icon={Download} size={15} />}
            onClick={handleExport}
          >
            Export CSV
          </TpButton>
        </div>
      </div>

      <section className={styles.card} aria-label={DASHBOARD_TITLE[tab]}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>{DASHBOARD_TITLE[tab]}</h2>
        </div>

        {tab === "funnel" && (
          <FunnelSection rollup={funnel} loading={loading} error={error} onRetry={reload} />
        )}
        {tab === "credits" && (
          <CreditUsageSection
            balance={balance}
            rollup={credit}
            loading={loading}
            error={error}
            onRetry={reload}
          />
        )}
        {tab === "deliverability" && <DeliverabilitySection onConnect={notifyConnectSoon} />}
        {tab === "team" && (
          <TeamActivitySection rollup={team} loading={loading} error={error} onRetry={reload} />
        )}
        {tab === "health" && (
          <DataHealthSection rollup={health} loading={loading} error={error} onRetry={reload} />
        )}
        {tab === "score" && <LeadScoreSection />}
      </section>

      <p className={styles.footnote}>
        MVP dashboards are composed in your browser from the credits and contacts APIs (over your most
        recent 200 reveals and contacts). Sending &amp; deliverability and lead score &amp; intent
        await the dedicated analytics pipeline (ClickHouse), which ships post-MVP.
      </p>
    </main>
  );
}
