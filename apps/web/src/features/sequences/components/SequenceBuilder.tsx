// SequenceBuilder.tsx — the inline create flow: phase 1 creates the sequence shell (name · from address ·
// CAN-SPAM physical address), phase 2 appends email steps (subject · body · delay hours) and recaps what
// was added this session. Async state lives in useSequenceBuilder; this file is the form presentation.
"use client";

import { type FormEvent, useState } from "react";
import { useSequenceBuilder } from "../hooks/useSequenceBuilder";
import styles from "../sequences.module.css";

export function SequenceBuilder({ onChanged }: { onChanged: () => void }) {
  const { created, steps, busy, error, create, addStep, finish } = useSequenceBuilder(onChanged);

  // Phase 1 fields (sequence shell).
  const [name, setName] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [physicalAddress, setPhysicalAddress] = useState("");

  // Phase 2 fields (one step at a time).
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [delayHours, setDelayHours] = useState("24");

  async function onCreate(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim() || busy) return;
    const ok = await create({
      name: name.trim(),
      ...(fromAddress.trim() ? { from_address: fromAddress.trim() } : {}),
      ...(physicalAddress.trim() ? { physical_address: physicalAddress.trim() } : {}),
    });
    if (ok) {
      setName("");
      setFromAddress("");
      setPhysicalAddress("");
    }
  }

  async function onAddStep(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!body.trim() || busy) return;
    const parsed = Number(delayHours);
    const ok = await addStep({
      channel: "email",
      delay_hours: Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0,
      ...(subject.trim() ? { subject: subject.trim() } : {}),
      body: body.trim(),
    });
    if (ok) {
      setSubject("");
      setBody("");
    }
  }

  if (created) {
    return (
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Add steps — {created.name}</h2>
          <p className={styles.cardHint}>
            Steps send in order; the delay is the wait after the previous step.
          </p>
        </div>

        {steps.length > 0 && (
          <ol className={styles.stepList}>
            {steps.map((s) => (
              <li key={s.id} className={styles.stepItem}>
                <span className={styles.stepOrder}>Step {s.stepOrder}</span>
                <span className={styles.stepSubject}>{s.subject || "(no subject)"}</span>
                <span className={styles.stepDelay}>
                  {s.delayHours === 0 ? "sends immediately" : `wait ${s.delayHours}h`}
                </span>
              </li>
            ))}
          </ol>
        )}

        <form className={styles.form} onSubmit={(e) => void onAddStep(e)}>
          <div className={styles.row}>
            <label className={styles.field}>
              <span className={styles.label}>Subject</span>
              <input
                className={styles.input}
                type="text"
                value={subject}
                placeholder="Quick question about {{company}}"
                onChange={(e) => setSubject(e.target.value)}
              />
            </label>

            <label className={`${styles.field} ${styles.fieldNarrow}`}>
              <span className={styles.label}>Delay (hours)</span>
              <input
                className={styles.input}
                type="number"
                min={0}
                step={1}
                value={delayHours}
                onChange={(e) => setDelayHours(e.target.value)}
              />
            </label>
          </div>

          <label className={styles.field}>
            <span className={styles.label}>Body</span>
            <textarea
              className={styles.textarea}
              value={body}
              placeholder="Write the email for this step…"
              onChange={(e) => setBody(e.target.value)}
              required
            />
          </label>

          <div className={styles.actions}>
            <button className={styles.button} type="submit" disabled={!body.trim() || busy}>
              {busy ? "Adding…" : "Add step"}
            </button>
            <button className={styles.ghostButton} type="button" onClick={finish} disabled={busy}>
              Done
            </button>
            {error && <p className={styles.error}>{error}</p>}
          </div>
        </form>
      </section>
    );
  }

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Create a sequence</h2>
        <p className={styles.cardHint}>Name it, set the sending identity, then add email steps.</p>
      </div>

      <form className={styles.form} onSubmit={(e) => void onCreate(e)}>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>Name</span>
            <input
              className={styles.input}
              type="text"
              value={name}
              placeholder="e.g. Q3 founders outbound"
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>From address</span>
            <input
              className={styles.input}
              type="email"
              value={fromAddress}
              placeholder="you@yourcompany.com"
              onChange={(e) => setFromAddress(e.target.value)}
            />
          </label>
        </div>

        <label className={styles.field}>
          <span className={styles.label}>Physical postal address</span>
          <input
            className={styles.input}
            type="text"
            value={physicalAddress}
            placeholder="100 Main St, Suite 4, Springfield, IL 62701"
            onChange={(e) => setPhysicalAddress(e.target.value)}
          />
          <span className={styles.fieldNote}>
            Required before any send — every email carries this address + an unsubscribe link.
          </span>
        </label>

        <div className={styles.actions}>
          <button className={styles.button} type="submit" disabled={!name.trim() || busy}>
            {busy ? "Creating…" : "Create sequence"}
          </button>
          {error && <p className={styles.error}>{error}</p>}
        </div>
      </form>
    </section>
  );
}
