// SequenceBuilder.tsx — the create flow as a Drawer (04 depth/overlay). The rep names the sequence, picks a
// sending identity + CAN-SPAM physical address, then composes ordered outreach steps (channel · delay ·
// subject · body) with add/remove/reorder. "Create sequence" persists the shell then each step in order
// (useSequenceBuilder). LinkedIn steps carry a human-in-the-loop note; a suppression-gated note reminds that
// every send is DNC/CAN-SPAM checked. Presentation + local form state; persistence lives in the hook.
"use client";

import {
  Drawer,
  FieldGroup,
  Icon,
  TpButton,
  TpIconButton,
  TpInput,
  TpSelect,
  TpTextarea,
} from "@leadwolf/ui";
import { ArrowDown, ArrowUp, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useSequenceBuilder } from "../hooks/useSequenceBuilder";
import styles from "../sequences.module.css";
import { CHANNEL_LABEL, type StepChannel } from "../types";

/** Sending identities are workspace mailbox connections (post-MVP); until wired we offer the typed-in from
 *  address as the single identity so the builder is usable without inventing a mailbox list. */
export function SequenceBuilder({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { steps, busy, error, addStep, removeStep, updateStep, moveStep, reset, submit } =
    useSequenceBuilder(onCreated);

  const [name, setName] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [physicalAddress, setPhysicalAddress] = useState("");

  function close(): void {
    reset();
    setName("");
    setFromAddress("");
    setPhysicalAddress("");
    onClose();
  }

  async function runSubmit(): Promise<void> {
    if (!name.trim() || busy) return;
    const ok = await submit({
      name: name.trim(),
      ...(fromAddress.trim() ? { from_address: fromAddress.trim() } : {}),
      ...(physicalAddress.trim() ? { physical_address: physicalAddress.trim() } : {}),
    });
    if (ok) close();
  }

  function onFormSubmit(e: FormEvent): void {
    e.preventDefault();
    void runSubmit();
  }

  return (
    <Drawer
      open={open}
      onClose={close}
      title="New sequence"
      width={560}
      footer={
        <div className={styles.drawerFooter}>
          {error ? <p className={styles.drawerError}>{error}</p> : <span />}
          <div style={{ display: "flex", gap: 8 }}>
            <TpButton variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </TpButton>
            <TpButton
              variant="primary"
              loading={busy}
              disabled={!name.trim()}
              onClick={() => void runSubmit()}
            >
              Create sequence
            </TpButton>
          </div>
        </div>
      }
    >
      <form className={styles.drawerForm} onSubmit={onFormSubmit}>
        <FieldGroup label="Name" htmlFor="seq-name">
          <TpInput
            id="seq-name"
            value={name}
            placeholder="e.g. Q3 founders outbound"
            onChange={(e) => setName(e.target.value)}
            required
          />
        </FieldGroup>

        <div className={styles.fieldRow}>
          <FieldGroup
            label="Sending identity"
            htmlFor="seq-from"
            hint="The from address every email step sends from."
          >
            <TpInput
              id="seq-from"
              type="email"
              value={fromAddress}
              placeholder="you@yourcompany.com"
              onChange={(e) => setFromAddress(e.target.value)}
            />
          </FieldGroup>
        </div>

        <FieldGroup
          label="Physical postal address"
          htmlFor="seq-addr"
          hint="Required before any send — every email carries this address + an unsubscribe link (CAN-SPAM)."
        >
          <TpInput
            id="seq-addr"
            value={physicalAddress}
            placeholder="100 Main St, Suite 4, Springfield, IL 62701"
            onChange={(e) => setPhysicalAddress(e.target.value)}
          />
        </FieldGroup>

        <p className={styles.suppressionNote}>
          <Icon icon={ShieldCheck} size={16} style={{ flex: "0 0 auto", marginTop: 1 }} />
          <span>
            Every send is checked against the suppression / do-not-contact list at dispatch time — a
            contact suppressed after enrollment is never sent to. LinkedIn steps stay human-in-the-loop.
          </span>
        </p>

        {steps.map((step, i) => (
          <div key={step.localId} className={styles.stepCard}>
            <div className={styles.stepCardHead}>
              <span className={styles.stepCardTitle}>
                <span className={styles.stepOrderBadge}>{i + 1}</span>
                {CHANNEL_LABEL[step.channel]} step
              </span>
              <div className={styles.stepCardActions}>
                <TpIconButton
                  label="Move step up"
                  disabled={i === 0}
                  onClick={() => moveStep(step.localId, -1)}
                >
                  <Icon icon={ArrowUp} size={15} />
                </TpIconButton>
                <TpIconButton
                  label="Move step down"
                  disabled={i === steps.length - 1}
                  onClick={() => moveStep(step.localId, 1)}
                >
                  <Icon icon={ArrowDown} size={15} />
                </TpIconButton>
                <TpIconButton
                  label="Remove step"
                  disabled={steps.length <= 1}
                  onClick={() => removeStep(step.localId)}
                >
                  <Icon icon={Trash2} size={15} />
                </TpIconButton>
              </div>
            </div>

            <div className={styles.stepFields}>
              <div className={styles.fieldRow}>
                <FieldGroup label="Channel">
                  <TpSelect
                    value={step.channel}
                    onChange={(e) =>
                      updateStep(step.localId, { channel: e.target.value as StepChannel })
                    }
                  >
                    <option value="email">Email</option>
                    <option value="linkedin">LinkedIn</option>
                  </TpSelect>
                </FieldGroup>
                <FieldGroup
                  className={styles.fieldNarrow}
                  label="Delay (hours)"
                  hint={i === 0 ? "from enroll" : "after previous"}
                >
                  <TpInput
                    type="number"
                    min={0}
                    step={1}
                    value={String(step.delayHours)}
                    onChange={(e) =>
                      updateStep(step.localId, { delayHours: Number(e.target.value) || 0 })
                    }
                  />
                </FieldGroup>
              </div>

              {step.channel === "email" && (
                <FieldGroup label="Subject">
                  <TpInput
                    value={step.subject}
                    placeholder="Quick question about {{company}}"
                    onChange={(e) => updateStep(step.localId, { subject: e.target.value })}
                  />
                </FieldGroup>
              )}

              <FieldGroup
                label={step.channel === "email" ? "Body" : "Message"}
                hint="Use merge fields like {{first_name}} — they resolve at send time."
              >
                <TpTextarea
                  value={step.body}
                  placeholder="Write the outreach for this step…"
                  rows={4}
                  onChange={(e) => updateStep(step.localId, { body: e.target.value })}
                />
              </FieldGroup>

              {step.channel === "linkedin" && (
                <p className={styles.linkedinNote}>
                  <span className={styles.noteDot} aria-hidden="true" />
                  <span>
                    LinkedIn actions carry account risk, so they are queued for you to send manually
                    (human-in-the-loop) rather than dispatched automatically.
                  </span>
                </p>
              )}
            </div>
          </div>
        ))}

        <div className={styles.addStepRow}>
          <TpButton
            variant="secondary"
            size="sm"
            leftIcon={<Icon icon={Plus} size={14} />}
            onClick={addStep}
            disabled={busy}
          >
            Add step
          </TpButton>
        </div>
      </form>
    </Drawer>
  );
}
