// EndpointPage.tsx — one endpoint, rendered from its typed spec.
//
// Every endpoint page is this component. That is the point of typing the contract (ADR-0048 §D3): parameters,
// return fields, errors and a worked example are structurally guaranteed to be present on all of them,
// because a spec missing any of those does not compile. Reference pages rot when each one is written by hand
// and the fifth one quietly omits the error table.

import { AvailabilityBadge } from "@/components/AvailabilityBadge.tsx";
import { CodeBlock } from "@/components/CodeBlock.tsx";
import { PageIntro } from "@/components/PageIntro.tsx";
import { ReferenceTable } from "@/components/ReferenceTable.tsx";
import type { Endpoint } from "@/content/types.ts";
import type { ReactNode } from "react";
import styles from "../api-reference.module.css";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionHeading}>{title}</h2>
      {children}
    </section>
  );
}

export function EndpointPage({ endpoint }: { endpoint: Endpoint }) {
  const paramRows = endpoint.params.map((param) => [
    param.name,
    param.type,
    param.required ? "Required" : "Optional",
    param.description,
  ]);
  const returnRows = endpoint.returns.map((field) => [
    field.name,
    field.type,
    field.provenance ? `${field.description} Carries provenance.` : field.description,
  ]);
  const errorRows = endpoint.errors.map((error) => [
    String(error.status),
    error.code,
    error.meaning,
  ]);

  return (
    <article>
      <PageIntro
        eyebrow="API reference"
        title={endpoint.title}
        lede={endpoint.summary}
        badge={<AvailabilityBadge availability={endpoint.availability} />}
      />

      <div className={styles.signature}>
        <span className={styles.method}>{endpoint.method}</span>
        <span className={styles.path}>{endpoint.path}</span>
      </div>
      <p className={styles.billing}>{endpoint.billing}</p>

      <Section title="Parameters">
        <ReferenceTable headers={["Name", "Type", "", "Description"]} rows={paramRows} />
      </Section>

      <Section title="Returns">
        <ReferenceTable headers={["Field", "Type", "Description"]} rows={returnRows} />
      </Section>

      <Section title="Example">
        <div className={styles.exampleGrid}>
          <CodeBlock language="bash" source={endpoint.example.request} />
          <CodeBlock language="json" source={endpoint.example.response} />
        </div>
      </Section>

      <Section title="Errors">
        <ReferenceTable headers={["Status", "Type", "Meaning"]} rows={errorRows} />
      </Section>
    </article>
  );
}
