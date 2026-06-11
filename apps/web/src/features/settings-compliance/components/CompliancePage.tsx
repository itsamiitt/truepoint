// CompliancePage.tsx — the Compliance & data surface (08, 12 §4): the suppression / DNC form and the public
// DSAR intake, each in its own card, under the "built-in, not bolted on" framing. This is the feature's
// public component, rendered by the thin (shell)/settings/compliance route. Composition only — the forms
// hold their own view state and talk to the backend via api.
"use client";

import styles from "../compliance.module.css";
import { DsarForm } from "./DsarForm";
import { SuppressionForm } from "./SuppressionForm";

export function CompliancePage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Compliance & data</h1>
        <p className={styles.subtitle}>
          Compliance is built-in, not bolted on: suppression is unbypassable and every request is
          honored at the source.
        </p>
      </header>

      <SuppressionForm />
      <DsarForm />
    </div>
  );
}
