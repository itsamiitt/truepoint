// ApiFactsStrip.tsx — the reference header card on the docs index: the base URL, then the three facts a
// developer orients by (auth scheme, error format, key scope). The API-documentation design's top strip.
//
// Every value is verified against the shipped platform, not the design mock: the base URL every example
// curls, the bearer scheme from the authentication guide, the problem+json contract from the errors guide,
// the `tp_live_` band from apiKeySecret.ts and the `search:read` scope both company routes require.
// Nothing else is claimed: the design's "General availability" and review-date cells are not reproduced,
// because the endpoint pages' availability badges are the site's one honesty mechanism and this strip must
// not contradict them.

import { ButtonLink } from "@/components/ButtonLink.tsx";
import { ACCESS_NOTE_SHORT } from "@/content/access.ts";
import { API_BASE_URL, CONTACT } from "@/content/site.ts";
import styles from "../api-reference.module.css";

const FACTS: readonly { label: string; value: string }[] = [
  { label: "Auth", value: "Bearer tp_live_…" },
  { label: "Errors", value: "application/problem+json" },
  { label: "Scope", value: "search:read" },
  { label: "Access", value: ACCESS_NOTE_SHORT },
];

export function ApiFactsStrip() {
  return (
    <div className={styles.facts}>
      <div className={styles.factsBar}>
        <div className={styles.factsBarLabel}>
          <span className={styles.factsEyebrow}>Base URL</span>
          <span className={styles.factsUrl}>{API_BASE_URL}</span>
        </div>
        <ButtonLink href={CONTACT.app} variant="primary">
          Get an API key
        </ButtonLink>
      </div>
      <div className={styles.factsGrid}>
        {FACTS.map((fact) => (
          <div key={fact.label} className={styles.factsCell}>
            <div className={styles.factsCellLabel}>{fact.label}</div>
            <div className={styles.factsCellValue}>{fact.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
