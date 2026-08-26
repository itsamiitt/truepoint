// DatasetPage.tsx — one dataset: the field list, and rows that show the file's shape.
//
// The rows below are fabricated, on RFC 2606 reserved domains, and they say so on the page. That is a
// compliance boundary rather than a presentation choice — publishing real business-contact records to
// anonymous visitors is an egress nobody can suppress and nobody can erase once it is cached. The field list
// is what a buyer is actually evaluating; the real sample goes out through a logged, suppression-checked
// path. Full reasoning in content/datasets.ts and ADR-0048 §D5.

import { AvailabilityBadge } from "@/components/AvailabilityBadge.tsx";
import { Note } from "@/components/Note.tsx";
import { ReferenceTable } from "@/components/ReferenceTable.tsx";
import { SAMPLE_NOTICE } from "@/content/datasets.ts";
import type { Dataset } from "@/content/types.ts";
import { PageContainer, PageHeader } from "@leadwolf/ui";
import styles from "../datasets.module.css";

export function DatasetPage({ dataset }: { dataset: Dataset }) {
  const fieldRows = dataset.fields.map((field) => [field.name, field.type, field.description]);
  const sampleHeaders = dataset.fields.map((field) => field.name);
  const sampleRows = dataset.sampleRows.map((row) => sampleHeaders.map((name) => row[name] ?? ""));

  return (
    <PageContainer width="default">
      <PageHeader
        eyebrow="Dataset"
        title={dataset.name}
        subtitle={dataset.summary}
        actions={<AvailabilityBadge availability={dataset.availability} />}
      />

      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>Coverage and refresh</h2>
        <div className={styles.meta}>
          <span>{dataset.coverage}</span>
          <span>{dataset.refresh}</span>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>Fields</h2>
        <ReferenceTable headers={["Field", "Type", "Description"]} rows={fieldRows} />
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>What a row looks like</h2>
        <div style={{ marginBottom: "var(--tp-space-4)" }}>
          <Note tone="warning">{SAMPLE_NOTICE}</Note>
        </div>
        <ReferenceTable headers={sampleHeaders} rows={sampleRows} />
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>Getting the real thing</h2>
        <p
          style={{
            margin: 0,
            fontSize: "var(--tp-text-label)",
            color: "var(--tp-ink-2)",
            maxWidth: "70ch",
          }}
        >
          A sample of the actual file is delivered on request rather than published here, because a
          live extract has to be checked against the suppression list at the moment it is sent —
          something a static page cannot do. Write to{" "}
          <a href="mailto:hello@truepoint.in">hello@truepoint.in</a> and say which dataset and which
          slice of it you want to evaluate.
        </p>
      </section>
    </PageContainer>
  );
}
