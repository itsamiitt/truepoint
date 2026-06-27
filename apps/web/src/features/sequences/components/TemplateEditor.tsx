// TemplateEditor.tsx — the create / edit / view dialog for one message template (M12 P2). Authors name +
// channel + subject + body + a workspace-share toggle, runs a SERVER-SIDE safe preview (merge fields resolved
// against sample data, values HTML-escaped — never dangerouslySetInnerHTML), and opens the version history.
// Owner-only edits (D8): a shared template the viewer doesn't own opens read-only (no Save/Archive/Restore).
// A content change (subject+body) appends an immutable version; channel is fixed after create. Pure transport
// over api.ts; toasts for feedback.
"use client";

import {
  Dialog,
  TpButton,
  TpChip,
  TpInput,
  TpSelect,
  TpSwitch,
  TpTextarea,
  useToast,
} from "@leadwolf/ui";
import { useCallback, useEffect, useState } from "react";
import { createTemplate, fetchTemplateDetail, previewTemplate, updateTemplate } from "../api";
import styles from "../sequences.module.css";
import {
  CHANNEL_LABEL,
  type StepChannel,
  type TemplateDetail,
  type TemplatePreview,
} from "../types";
import { VersionHistoryDrawer } from "./VersionHistoryDrawer";

interface Snapshot {
  name: string;
  subject: string;
  body: string;
  shared: boolean;
}

export function TemplateEditor({
  templateId,
  open,
  onClose,
  onSaved,
}: {
  /** null = create a new template; a string = edit/view the existing one. */
  templateId: string | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const isCreate = templateId === null;

  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [channel, setChannel] = useState<StepChannel>("email");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [shared, setShared] = useState(false);
  const [original, setOriginal] = useState<Snapshot | null>(null);

  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const [historyOpen, setHistoryOpen] = useState(false);

  const canEdit = isCreate || (detail?.canEdit ?? false);
  const status = detail?.status ?? "active";

  const resetForm = useCallback(() => {
    setName("");
    setChannel("email");
    setSubject("");
    setBody("");
    setShared(false);
    setOriginal(null);
    setDetail(null);
    setDetailError(null);
    setFormError(null);
    setPreview(null);
  }, []);

  const loadDetail = useCallback(async () => {
    if (templateId === null) return;
    setLoadingDetail(true);
    setDetailError(null);
    try {
      const d = await fetchTemplateDetail(templateId);
      setDetail(d);
      setName(d.name);
      setChannel(d.channel);
      setSubject(d.subject ?? "");
      setBody(d.body);
      setShared(d.shared);
      setOriginal({ name: d.name, subject: d.subject ?? "", body: d.body, shared: d.shared });
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : "Could not load the template");
    } finally {
      setLoadingDetail(false);
    }
  }, [templateId]);

  // Populate (edit) or clear (create) whenever the dialog opens for a different target.
  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setFormError(null);
    if (templateId === null) resetForm();
    else void loadDetail();
  }, [open, templateId, loadDetail, resetForm]);

  const canSubmit = name.trim().length > 0 && body.trim().length > 0 && !busy && canEdit;

  async function onSave(): Promise<void> {
    if (!canSubmit) return;
    setBusy(true);
    setFormError(null);
    try {
      if (isCreate) {
        await createTemplate({
          name: name.trim(),
          subject: subject.trim() || null,
          body,
          channel,
          shared,
        });
        toast.success("Template created");
      } else if (templateId && original) {
        const patch: Parameters<typeof updateTemplate>[1] = {};
        // Compare against the SAME normalized value we persist, so a whitespace-only subject edit doesn't
        // append a spurious immutable version.
        const nextSubject = subject.trim() || null;
        const origSubject = original.subject.trim() || null;
        const contentChanged = body !== original.body || nextSubject !== origSubject;
        if (contentChanged) {
          patch.body = body;
          patch.subject = nextSubject;
        }
        if (name.trim() !== original.name) patch.name = name.trim();
        if (shared !== original.shared) patch.shared = shared;
        if (Object.keys(patch).length === 0) {
          toast.toast({ title: "No changes to save" });
          setBusy(false);
          return;
        }
        await updateTemplate(templateId, patch);
        toast.success("Template saved");
      }
      onSaved();
      onClose();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Could not save the template");
    } finally {
      setBusy(false);
    }
  }

  async function onToggleArchive(): Promise<void> {
    if (!templateId || !canEdit) return;
    setBusy(true);
    setFormError(null);
    const nextStatus = status === "active" ? "archived" : "active";
    try {
      await updateTemplate(templateId, { status: nextStatus });
      toast.success(nextStatus === "archived" ? "Template archived" : "Template restored");
      onSaved();
      onClose();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Could not change the template status");
    } finally {
      setBusy(false);
    }
  }

  async function onPreview(): Promise<void> {
    if (templateId === null) return; // preview is server-side; a brand-new template must be saved first
    setPreviewing(true);
    setFormError(null);
    try {
      setPreview(await previewTemplate(templateId, { subject: subject.trim() || null, body }));
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Could not preview the template");
    } finally {
      setPreviewing(false);
    }
  }

  const title = isCreate ? "New template" : canEdit ? "Edit template" : name || "Template";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      maxWidth={680}
      footer={
        <div className={styles.editorFoot}>
          <div className={styles.editorFootLeft}>
            {!isCreate ? (
              <TpButton variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
                Version history
              </TpButton>
            ) : null}
            {!isCreate && canEdit ? (
              <TpButton
                variant={status === "active" ? "ghost" : "secondary"}
                size="sm"
                onClick={() => void onToggleArchive()}
                disabled={busy}
              >
                {status === "active" ? "Archive" : "Restore to active"}
              </TpButton>
            ) : null}
          </div>
          <div className={styles.editorFootRight}>
            <TpButton variant="secondary" onClick={onClose} disabled={busy}>
              Close
            </TpButton>
            {canEdit ? (
              <TpButton onClick={() => void onSave()} disabled={!canSubmit} loading={busy}>
                {isCreate ? "Create template" : "Save changes"}
              </TpButton>
            ) : null}
          </div>
        </div>
      }
    >
      {loadingDetail ? (
        <p className={styles.editorLoading}>Loading template…</p>
      ) : detailError ? (
        <div className={styles.editorError}>
          <p className={styles.templateFormError}>{detailError}</p>
          <TpButton variant="secondary" size="sm" onClick={() => void loadDetail()}>
            Retry
          </TpButton>
        </div>
      ) : (
        <div className={styles.editorBody}>
          {!canEdit ? (
            <p className={styles.editorReadonlyNote}>
              This template is shared by another teammate — you can view and preview it, but only
              its owner can edit it.
            </p>
          ) : null}

          <div className={styles.templateFormRow}>
            <label className={styles.templateFormField} htmlFor="tpl-name">
              <span className={styles.templateFormLabel}>Name</span>
              <TpInput
                id="tpl-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Intro — founders"
                disabled={!canEdit}
              />
            </label>
            <label className={styles.templateFormField} htmlFor="tpl-channel">
              <span className={styles.templateFormLabel}>Channel</span>
              <TpSelect
                id="tpl-channel"
                value={channel}
                onChange={(e) => setChannel(e.target.value as StepChannel)}
                disabled={!canEdit || !isCreate}
              >
                {(Object.keys(CHANNEL_LABEL) as StepChannel[]).map((ch) => (
                  <option key={ch} value={ch}>
                    {CHANNEL_LABEL[ch]}
                  </option>
                ))}
              </TpSelect>
            </label>
          </div>

          <label className={styles.templateFormField} htmlFor="tpl-subject">
            <span className={styles.templateFormLabel}>Subject (optional)</span>
            <TpInput
              id="tpl-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Quick intro, {{first_name}}"
              disabled={!canEdit}
            />
          </label>

          <label className={styles.templateFormField} htmlFor="tpl-body">
            <span className={styles.templateFormLabel}>Body</span>
            <TpTextarea
              id="tpl-body"
              rows={7}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Hi {{first_name | there}} — saw {{company}} is growing…"
              disabled={!canEdit}
            />
          </label>

          <div className={styles.editorControlsRow}>
            {canEdit ? (
              <label className={styles.editorShareToggle} htmlFor="tpl-shared">
                <TpSwitch
                  id="tpl-shared"
                  checked={shared}
                  onChange={(e) => setShared(e.target.checked)}
                />
                <span>Share with the workspace</span>
              </label>
            ) : (
              <span />
            )}
            <TpButton
              variant="secondary"
              size="sm"
              onClick={() => void onPreview()}
              loading={previewing}
              disabled={isCreate || body.trim().length === 0}
            >
              Preview
            </TpButton>
          </div>
          {isCreate ? (
            <p className={styles.editorHint}>Create the template to preview it with sample data.</p>
          ) : null}

          {formError ? <p className={styles.templateFormError}>{formError}</p> : null}

          {preview ? (
            <div className={styles.templatePreview}>
              <span className={styles.editorSectionLabel}>Preview · sample data (HTML source)</span>
              {preview.subject ? (
                <div className={styles.templatePreviewSubject}>{preview.subject}</div>
              ) : null}
              <pre className={styles.templatePreviewBody}>{preview.body}</pre>
              <p className={styles.editorHint}>
                The body is the email&rsquo;s HTML source — merge values are HTML-escaped so they
                render as literal text, never markup, for the recipient.
              </p>
              {preview.fields.length > 0 ? (
                <div className={styles.templateFieldChips}>
                  {preview.fields.map((f) => (
                    <TpChip key={f}>{f}</TpChip>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {templateId !== null ? (
        <VersionHistoryDrawer
          templateId={templateId}
          canEdit={canEdit}
          currentVersion={detail?.currentVersion ?? null}
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          onRestored={() => {
            void loadDetail();
            onSaved();
            toast.success("Version restored");
          }}
        />
      ) : null}
    </Dialog>
  );
}
