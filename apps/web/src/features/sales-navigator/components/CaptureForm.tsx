// CaptureForm.tsx — the assisted-capture form (05 §5, M7, ADR-0009): a human pastes a Sales Navigator / LinkedIn
// URL with an optional note + labels and saves it. HITL only — nothing is automated against LinkedIn. All UI is
// the @leadwolf/ui kit + tokens; no hardcoded colors. Submits via the slice hook; the parent reloads the list.
"use client";

import type { SalesNavLinkRequest, SalesNavLinkType } from "@leadwolf/types";
import { TpButton, TpChip, TpInput, TpSelect, TpTextarea, useToast } from "@leadwolf/ui";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { LINK_TYPE_OPTIONS } from "../types";

const MAX_LABELS = 20;
const MAX_LABEL_LEN = 40;

export function CaptureForm({
  onCapture,
}: {
  /** Resolves to whether the capture deduped onto an existing row. Throws on failure. */
  onCapture: (body: SalesNavLinkRequest) => Promise<{ deduped: boolean }>;
}) {
  const { success, error: toastError } = useToast();
  const [linkType, setLinkType] = useState<SalesNavLinkType>("profile");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [labelDraft, setLabelDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [urlInvalid, setUrlInvalid] = useState(false);

  const addLabel = () => {
    const next = labelDraft.trim().slice(0, MAX_LABEL_LEN);
    if (!next || labels.includes(next) || labels.length >= MAX_LABELS) {
      setLabelDraft("");
      return;
    }
    setLabels((cur) => [...cur, next]);
    setLabelDraft("");
  };

  const onLabelKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addLabel();
    }
  };

  const reset = () => {
    setUrl("");
    setNote("");
    setLabels([]);
    setLabelDraft("");
    setLinkType("profile");
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedUrl = url.trim();
    // Native URL validity check before hitting the server (the api also Zod-validates).
    let validUrl = false;
    try {
      const u = new URL(trimmedUrl);
      validUrl = u.protocol === "http:" || u.protocol === "https:";
    } catch {
      validUrl = false;
    }
    if (!validUrl) {
      setUrlInvalid(true);
      return;
    }
    setUrlInvalid(false);
    setSubmitting(true);
    try {
      const body: SalesNavLinkRequest = {
        link_type: linkType,
        url: trimmedUrl,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(labels.length > 0 ? { labels } : {}),
      };
      const { deduped } = await onCapture(body);
      if (deduped) success("Already captured", "This link was already in your workspace.");
      else success("Link captured");
      reset();
    } catch (err) {
      toastError("Capture failed", err instanceof Error ? err.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="lw-card" onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gap: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Capture a Sales Navigator link</span>
        <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>
          Paste a LinkedIn / Sales Navigator URL. Assisted only — nothing is sent or automated on
          LinkedIn.
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <TpSelect
          aria-label="Link type"
          value={linkType}
          onChange={(e) => setLinkType(e.target.value as SalesNavLinkType)}
          style={{ maxWidth: 180 }}
        >
          {LINK_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </TpSelect>
        <TpInput
          aria-label="Sales Navigator URL"
          type="url"
          inputMode="url"
          placeholder="https://www.linkedin.com/sales/lead/…"
          value={url}
          invalid={urlInvalid}
          onChange={(e) => {
            setUrl(e.target.value);
            if (urlInvalid) setUrlInvalid(false);
          }}
          style={{ flex: 1, minWidth: 240 }}
        />
      </div>
      {urlInvalid ? (
        <span style={{ fontSize: 12, color: "var(--danger)" }}>Enter a valid http(s) URL.</span>
      ) : null}

      <TpTextarea
        aria-label="Note"
        placeholder="Optional note (why this lead, context, next step)…"
        value={note}
        maxLength={2000}
        rows={2}
        onChange={(e) => setNote(e.target.value)}
      />

      <div style={{ display: "grid", gap: 6 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <TpInput
            aria-label="Add label"
            placeholder="Add a label, press Enter"
            value={labelDraft}
            maxLength={MAX_LABEL_LEN}
            onChange={(e) => setLabelDraft(e.target.value)}
            onKeyDown={onLabelKey}
            style={{ maxWidth: 220 }}
          />
          <TpButton variant="secondary" size="sm" onClick={addLabel} disabled={!labelDraft.trim()}>
            Add label
          </TpButton>
        </div>
        {labels.length > 0 ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {labels.map((l) => (
              <TpChip key={l} onRemove={() => setLabels((cur) => cur.filter((x) => x !== l))}>
                {l}
              </TpChip>
            ))}
          </div>
        ) : null}
      </div>

      <div>
        <TpButton type="submit" loading={submitting} disabled={!url.trim()}>
          Capture link
        </TpButton>
      </div>
    </form>
  );
}
