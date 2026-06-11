// ReportsPage.tsx — the Reports destination (11 §4.5 MVP slice): credit usage, pipeline funnel, and data
// health, composed client-side from the existing credits + contacts endpoints. Spinner while loading;
// quiet empty states; a muted footnote notes the ClickHouse pipeline is post-MVP. Public slice component.
"use client";

import { Spinner } from "@leadwolf/ui";
import { useReports } from "../hooks/useReports";
import styles from "../reports.module.css";
import { CreditUsageSection } from "./CreditUsageSection";
import { DataHealthSection } from "./DataHealthSection";
import { FunnelSection } from "./FunnelSection";

export function ReportsPage() {
  const { balance, credit, funnel, health, error, loading } = useReports();

  return (
    <main className={styles.page}>
      <header className={styles.heading}>
        <h1 className={styles.title}>Reports</h1>
        <p className={styles.subtitle}>
          Credit spend, pipeline, and data health for this workspace.
        </p>
      </header>

      {error && <p className={styles.error}>{error}</p>}

      {loading ? (
        <div className={styles.loadingRow}>
          <Spinner /> Loading reports…
        </div>
      ) : (
        <>
          {balance != null && credit && <CreditUsageSection balance={balance} rollup={credit} />}
          {funnel && <FunnelSection rollup={funnel} />}
          {health && <DataHealthSection rollup={health} />}
        </>
      )}

      <p className={styles.footnote}>
        MVP reports are composed in your browser from the credits and contacts APIs (credit usage
        covers your last 100 reveals). The dedicated analytics pipeline (ClickHouse) ships post-MVP.
      </p>
    </main>
  );
}
