// ApiDocsPanel.tsx — Developer ▸ API docs: a small grid of cards linking to the OpenAPI reference and the
// sandbox. Static, link-only — the docs/sandbox surfaces are an M10 deliverable, so links point at the
// documented locations on the API origin and open in a new tab. No async surface here.
"use client";

import { Card, TpButton } from "@leadwolf/ui";
import { BookOpen, FlaskConical, Code2 } from "lucide-react";
import { API_BASE } from "@/lib/publicConfig";
import styles from "../settings-developer.module.css";

const DOCS = [
  {
    icon: <BookOpen size={20} />,
    title: "OpenAPI reference",
    body: "The full REST contract — endpoints, request and response schemas, and error shapes.",
    href: `${API_BASE}/docs`,
    cta: "Open reference",
  },
  {
    icon: <Code2 size={20} />,
    title: "OpenAPI spec",
    body: "The machine-readable spec to generate clients and import into Postman or Insomnia.",
    href: `${API_BASE}/openapi.json`,
    cta: "Download spec",
  },
  {
    icon: <FlaskConical size={20} />,
    title: "Sandbox",
    body: "Try calls against test data with sandbox keys before going live — no credits spent.",
    href: `${API_BASE}/sandbox`,
    cta: "Open sandbox",
  },
];

export function ApiDocsPanel() {
  return (
    <section>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadText}>
          <h2 className={styles.panelTitle}>API docs</h2>
          <p className={styles.panelDesc}>
            Build against the public API with the reference, machine-readable spec, and a credit-free sandbox.
          </p>
        </div>
      </div>
      <div className={styles.docGrid}>
        {DOCS.map((d) => (
          <Card key={d.title} as="article">
            <div className={styles.docCard}>
              <span className={styles.docIcon} aria-hidden>
                {d.icon}
              </span>
              <span className={styles.docTitle}>{d.title}</span>
              <p className={styles.docBody}>{d.body}</p>
              <a href={d.href} target="_blank" rel="noopener noreferrer" className={styles.docLink}>
                <TpButton variant="secondary" size="sm">
                  {d.cta}
                </TpButton>
              </a>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
