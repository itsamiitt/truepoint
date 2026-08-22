// EndpointPage.tsx — one endpoint, rendered from its typed spec, in the API-documentation design's shape:
// the method signature above the title, then a prose column (billing, parameters, returns, errors) with the
// worked request/response samples sticky beside it.
//
// Every endpoint page is this component. That is the point of typing the contract (ADR-0048 §D3): parameters,
// return fields, errors and a worked example are structurally guaranteed to be present on all of them,
// because a spec missing any of those does not compile. Reference pages rot when each one is written by hand
// and the fifth one quietly omits the error table.

import { AvailabilityBadge } from "@/components/AvailabilityBadge.tsx";
import { CodeBlock } from "@/components/CodeBlock.tsx";
import { PageIntro } from "@/components/PageIntro.tsx";
import { ReferenceTable } from "@/components/ReferenceTable.tsx";
import { ACCESS_NOTE } from "@/content/access.ts";
import { buildSnippets } from "@/content/snippets.ts";
import type { Endpoint } from "@/content/types.ts";
import type { ReactNode } from "react";
import styles from "../api-reference.module.css";
import { SnippetTabs } from "./SnippetTabs.tsx";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionHeading}>{title}</h2>
      {children}
    </section>
  );
}

export function EndpointPage({ endpoint }: { endpoint: Endpoint }) {
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
      <div className={styles.signature}>
        <span
          className={`${styles.method} ${
            endpoint.method === "GET" ? styles.methodGet : styles.methodPost
          }`}
        >
          {endpoint.method}
        </span>
        <span className={styles.path}>{endpoint.path}</span>
        {endpoint.credits === 0 ? (
          <span className={styles.costFree}>Free</span>
        ) : (
          <span className={styles.costMetered}>
            {endpoint.credits === 1
              ? "1 credit per match"
              : `${endpoint.credits} credits per match`}
          </span>
        )}
      </div>

      <PageIntro
        eyebrow="API reference"
        title={endpoint.title}
        lede={endpoint.summary}
        badge={<AvailabilityBadge availability={endpoint.availability} />}
      />

      <div className={styles.split}>
        <div>
          <p className={styles.billing} style={{ marginTop: "var(--tp-space-6)" }}>
            {endpoint.billing}
          </p>

          <Section title={endpoint.method === "GET" ? "Query parameters" : "Body"}>
            {endpoint.params.map((param) => (
              <div key={param.name} className={styles.paramCard}>
                <div className={styles.paramHead}>
                  <span className={styles.paramName}>{param.name}</span>
                  <span className={styles.paramType}>{param.type}</span>
                  <span className={param.required ? styles.paramRequired : styles.paramType}>
                    {param.required ? "required" : "optional"}
                  </span>
                </div>
                <p className={styles.paramDescription}>{param.description}</p>
              </div>
            ))}
          </Section>

          <Section title="Returns">
            <ReferenceTable headers={["Field", "Type", "Description"]} rows={returnRows} />
          </Section>

          <Section title="Errors">
            <ReferenceTable headers={["Status", "Code", "Meaning"]} rows={errorRows} />
          </Section>
        </div>

        <aside className={styles.aside} aria-label="Worked example">
          {endpoint.availability === "planned" ? null : (
            <p className={styles.asideNote}>{ACCESS_NOTE}</p>
          )}
          <SnippetTabs snippets={buildSnippets(endpoint)} />
          <CodeBlock language="Response · 200" source={endpoint.example.response} />
        </aside>
      </div>
    </article>
  );
}
