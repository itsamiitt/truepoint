// SuppressionList.tsx — view + remove existing suppression / DNC entries (08 §3, T-1b27d4ce). Loads the
// workspace's MANAGEABLE entries (global rows are platform-managed and excluded server-side) and lets an
// admin remove one. Email/phone entries are stored as one-way blind-index HMACs, so they surface by TYPE
// only (masked); domain/contact-id entries show their key. Presentation + local view state only; data via
// api. Reloads when SuppressionForm dispatches "suppression:changed" so a newly-added entry appears at once.
"use client";

import type { SuppressionListItem } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { listSuppressions, removeSuppression } from "../api";
import styles from "../compliance.module.css";

const MATCH_LABEL: Record<string, string> = {
  email: "Email",
  domain: "Domain",
  phone: "Phone",
  contact_id: "Contact",
};

/** The human-readable key for a row, or a masked label when only a blind index exists (email / phone). */
function entryKey(e: SuppressionListItem): string {
  if (e.match_type === "domain") return e.domain ?? "—";
  if (e.match_type === "contact_id") return e.contact_id ?? "—";
  return "stored privately"; // email/phone are kept as a one-way hash and never shown back
}

export function SuppressionList() {
  const [entries, setEntries] = useState<SuppressionListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setEntries(await listSuppressions());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the suppression list");
    }
  }, []);

  useEffect(() => {
    void load();
    const onChanged = () => void load();
    window.addEventListener("suppression:changed", onChanged);
    return () => window.removeEventListener("suppression:changed", onChanged);
  }, [load]);

  async function onRemove(id: string): Promise<void> {
    setRemovingId(id);
    setError(null);
    try {
      await removeSuppression(id);
      setEntries((cur) => (cur ? cur.filter((e) => e.id !== id) : cur));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the entry");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Current suppression list</h2>
        <p className={styles.cardHint}>
          Entries that block reveals and sends. Email entries are stored privately (matched by a
          one-way hash), so they show by type only.
        </p>
      </div>

      {error && <p className={styles.error}>{error}</p>}

      {entries === null ? (
        <p className={styles.cardHint}>Loading…</p>
      ) : entries.length === 0 ? (
        <p className={styles.empty}>No suppression entries yet. Add one above.</p>
      ) : (
        <ul className={styles.list}>
          {entries.map((e) => (
            <li key={e.id} className={styles.listRow}>
              <div className={styles.listMain}>
                <span className={styles.listType}>{MATCH_LABEL[e.match_type] ?? e.match_type}</span>
                <span className={styles.listKey}>{entryKey(e)}</span>
                {e.reason && <span className={styles.listReason}>{e.reason}</span>}
              </div>
              <div className={styles.listMeta}>
                <span className={styles.listScope}>{e.scope}</span>
                <button
                  className={styles.removeButton}
                  type="button"
                  onClick={() => void onRemove(e.id)}
                  disabled={removingId === e.id}
                >
                  {removingId === e.id ? "Removing…" : "Remove"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
