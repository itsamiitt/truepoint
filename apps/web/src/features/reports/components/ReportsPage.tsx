// ReportsPage.tsx — the Reports destination (11 §4.5 MVP slice): a Tabs dashboard switcher over six sections
// (Pipeline funnel · Credit usage · Sending & deliverability · Team activity · Data health · Lead score &
// intent). A shared date-range + member filter row drives the three dashboards composed from live data; the
// two without a backend yet render first-class empty states. Each dashboard has an Export CSV action. The
// ClickHouse /reports/* pipeline (ADR-0010) is post-MVP. Public slice component.
"use client";

import { PageHeader } from "@/components/PageHeader";
import { Combobox, Icon, SegmentedControl, Tabs, TpButton, useToast } from "@leadwolf/ui";
import { Download, RotateCw } from "lucide-react";
import { useState } from "react";
import {
  type ExportFormat,
  type ReportDataset,
  creditUsageDataset,
  dataHealthDataset,
  downloadDataset,
  funnelDataset,
  teamDataset,
} from "../export";
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
  const [format, setFormat] = useState<ExportFormat>("csv");

  const memberCombo = [{ value: "all", label: "All members" }, ...memberOptions];

  // Build the export dataset for the active dashboard ONCE (headers + rows), so CSV and XLSX emit identical
  // PII-free, workspace-scoped columns. Returns null for dashboards that have no data (or no backend yet).
  function activeDataset(): ReportDataset | null {
    if (tab === "credits" && credit && credit.byType.length > 0) return creditUsageDataset(credit);
    if (tab === "team" && team && team.rows.length > 0) return teamDataset(team);
    if (tab === "funnel" && funnel && funnel.total > 0) return funnelDataset(funnel);
    if (tab === "health" && health && health.total > 0) return dataHealthDataset(health);
    return null;
  }

  // Export the active dashboard in the chosen format. Dashboards without a data source toast "Coming soon".
  function handleExport() {
    const dataset = activeDataset();
    if (!dataset) {
      toast({
        tone: "default",
        title: "Coming soon",
        description: "Nothing to export for this dashboard yet.",
      });
      return;
    }
    downloadDataset(dataset, format);
    success("Export ready", `${DASHBOARD_TITLE[tab]} ${format.toUpperCase()} downloaded.`);
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
      <PageHeader
        title="Reports"
        subtitle="Pipeline, spend, deliverability, team, and data health for this workspace."
      />

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
          <SegmentedControl
            items={[
              { value: "csv", label: "CSV" },
              { value: "xlsx", label: "XLSX" },
            ]}
            value={format}
            onChange={(v) => setFormat(v as ExportFormat)}
            aria-label="Export format"
          />
          <TpButton
            variant="secondary"
            size="sm"
            leftIcon={<Icon icon={Download} size={15} />}
            onClick={handleExport}
          >
            Export
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
        MVP dashboards are composed in your browser from the credits and contacts APIs (over your
        most recent 200 reveals and contacts). Sending &amp; deliverability and lead score &amp;
        intent await the dedicated analytics pipeline (ClickHouse), which ships post-MVP.
      </p>
    </main>
  );
}
