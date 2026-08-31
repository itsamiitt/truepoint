// ChannelValuesPopover.tsx — the "+N" affordance on a revealed email/phone cell (Search v4, 2026-08-31):
// the inline cell keeps showing THE PRIMARY value (CH-INV-1 — the flat cache), and this pill opens a
// popover listing ALL live values of that channel — value, usage-type tag, per-value verification grade,
// primary first — with a copy-all footer. Data is the S-CH4 post-reveal read (`RevealedContact.emails` /
// `.phones`, already decrypted for OWNED types only): rendering it adds no new PII exposure — the workspace
// paid for the channel and every value in the list rides the same owned claim. Gate-off the arrays are
// absent and the pill simply never renders.
"use client";

import type { RevealedEmailValue, RevealedPhoneValue } from "@leadwolf/types";
import { Popover, TpButton, useToast } from "@leadwolf/ui";
import styles from "../prospect.module.css";
import { emailStatusLabel, emailStatusTone, phoneLineTypeLabel } from "../types";

type AnyValue = RevealedEmailValue | RevealedPhoneValue;

/** Usage-type tag ("work" → "Work", "hq" → "HQ"). */
function typeLabel(t: string): string {
  if (t === "hq") return "HQ";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function statusText(field: "email" | "phone", v: AnyValue): string | null {
  if (field === "email") return emailStatusLabel(v.status ?? "unknown");
  const p = v as RevealedPhoneValue;
  return phoneLineTypeLabel(p.lineType ?? null) ?? (p.status ? typeLabel(p.status) : null);
}

function statusTone(field: "email" | "phone", v: AnyValue): "success" | "danger" | "muted" {
  if (field === "email") {
    const tone = emailStatusTone(v.status ?? "unknown");
    return tone === "success" || tone === "danger" ? tone : "muted";
  }
  return (v as RevealedPhoneValue).status === "invalid" ? "danger" : "muted";
}

export function ChannelValuesPopover({
  field,
  values,
}: {
  field: "email" | "phone";
  /** ALL live values, primary-first (the S-CH4 contract). The pill renders only when there is more than one. */
  values: AnyValue[];
}) {
  const toast = useToast();
  if (values.length < 2) return null;
  const noun = field === "email" ? "email" : "phone";

  const copyAll = () => {
    const text = values
      .map((v) => {
        const ext = field === "phone" ? (v as RevealedPhoneValue).extension : null;
        return ext ? `${v.value} ext. ${ext}` : v.value;
      })
      .join("\n");
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.success(`${values.length} ${noun}s copied`))
      .catch(() => toast.error("Copy failed", "Your browser blocked clipboard access."));
  };

  return (
    <span
      className={styles.chWrap}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <Popover
        className={styles.chPanel}
        trigger={({ toggle, props }) => (
          <button
            type="button"
            className={styles.chPlus}
            onClick={toggle}
            aria-label={`Show all ${values.length} ${noun}s`}
            {...props}
          >
            +{values.length - 1}
          </button>
        )}
      >
        <div className={styles.chList}>
          <p className={styles.chHead}>
            {values.length} {noun}s
          </p>
          {values.map((v) => {
            const status = statusText(field, v);
            return (
              <div key={`${v.type}:${v.value}`} className={styles.chRow} data-primary={v.isPrimary}>
                <span className={styles.chValue}>{v.value}</span>
                <span className={styles.chType}>{typeLabel(v.type)}</span>
                {status ? (
                  <span className={styles.chStatus} data-tone={statusTone(field, v)}>
                    {status}
                  </span>
                ) : null}
              </div>
            );
          })}
          <div className={styles.chFoot}>
            <TpButton variant="ghost" size="sm" onClick={copyAll}>
              Copy all
            </TpButton>
          </div>
        </div>
      </Popover>
    </span>
  );
}
