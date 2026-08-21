// DatasetsPage.tsx — the catalogue of packaged flat-file datasets.

import { AvailabilityBadge } from "@/components/AvailabilityBadge.tsx";
import { PageIntro } from "@/components/PageIntro.tsx";
import { DATASETS } from "@/content/datasets.ts";
import { Card, PageContainer } from "@leadwolf/ui";
import Link from "next/link";
import styles from "../datasets.module.css";

export function DatasetsPage() {
  return (
    <PageContainer width="default">
      <PageIntro
        eyebrow="Datasets"
        title="Packaged datasets, refreshed monthly."
        lede="A cleaned, verified file for one vertical, delivered as CSV and JSON. No integration, no API key — for teams who want the list rather than the plumbing."
      />

      <div className={styles.section}>
        <div className={styles.grid}>
          {DATASETS.map((dataset) => (
            <Card key={dataset.slug} as="article">
              <h2 className={styles.cardTitle}>{dataset.name}</h2>
              <p className={styles.cardSummary}>{dataset.summary}</p>
              <div className={styles.meta}>
                <span>{dataset.coverage}</span>
                <span>{dataset.refresh}</span>
              </div>
              <div className={styles.cardFooter}>
                <AvailabilityBadge availability={dataset.availability} />
                <Link href={`/datasets/${dataset.slug}`}>Fields and sample &rarr;</Link>
              </div>
            </Card>
          ))}
        </div>
      </div>

      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>What every file guarantees</h2>
        <p style={{ margin: 0, fontSize: 14, color: "var(--tp-ink-2)", maxWidth: "70ch" }}>
          Every row carries the date its contact address last passed verification, so you can tell
          how old the file really is rather than trusting a refresh cadence. Rows that fail
          verification are dropped rather than shipped, and anyone who has opted out is absent from
          the file entirely.
        </p>
      </section>
    </PageContainer>
  );
}
