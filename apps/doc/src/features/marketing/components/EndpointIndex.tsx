// EndpointIndex.tsx — the compact "what you can call" list, generated from the endpoint contract.
//
// Reads ENDPOINTS rather than restating them, so an endpoint added to the contract appears here, on the
// sitemap and in the sidebar with no further edits. The credit cost sits on the row because "how much does
// this call cost" is the second question every developer asks and the one most vendors bury.

import { ENDPOINTS } from "@/content/endpoints/index.ts";
import Link from "next/link";
import styles from "../marketing.module.css";

function costLabel(credits: number): string {
  if (credits === 0) return "Free";
  return credits === 1 ? "1 credit" : `${credits} credits`;
}

export function EndpointIndex() {
  return (
    <ul className={styles.endpointList}>
      {ENDPOINTS.map((endpoint) => (
        <li key={endpoint.slug}>
          <Link href={`/docs/api/${endpoint.slug}`} className={styles.endpointRow}>
            <span className={styles.method}>{endpoint.method}</span>
            <span className={styles.path}>{endpoint.path}</span>
            <span className={styles.endpointSummary}>{endpoint.title}</span>
            <span className={styles.cost}>{costLabel(endpoint.credits)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
