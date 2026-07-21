// TemplateControls.tsx — the saved-mapping-template bar (apply a workspace template · save the current map
// as one — G-IMP-3). Extracted unchanged from ImportWizard.tsx (S-U7 file-size split) so both wizard flows
// share one template surface. `children` (the mapping grid) renders BETWEEN the apply select and the save
// row — the exact legacy DOM order, so the gate-off card stays byte-identical. The parent owns the state.
"use client";

import type { ImportMappingTemplate } from "@leadwolf/types";
import { TpButton, TpInput, TpSelect } from "@leadwolf/ui";
import type { ReactNode } from "react";

export function TemplateControls({
  templates,
  onApply,
  templateName,
  onTemplateName,
  onSave,
  saving,
  canSave,
  message,
  children,
}: {
  templates: ImportMappingTemplate[];
  onApply: (id: string) => void;
  templateName: string;
  onTemplateName: (name: string) => void;
  onSave: () => void;
  saving: boolean;
  canSave: boolean;
  message: string | null;
  /** The mapping grid — rendered between the apply select and the save row (the legacy order). */
  children?: ReactNode;
}) {
  return (
    <>
      {templates.length > 0 && (
        <label className="tp-field">
          <span>Apply a saved template</span>
          <TpSelect
            value=""
            onChange={(e) => {
              if (e.target.value) onApply(e.target.value);
            }}
          >
            <option value="">— choose a template —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </TpSelect>
        </label>
      )}

      {children}

      <div className="tp-row">
        <label className="tp-field">
          <span>Save this mapping as a template</span>
          <TpInput
            type="text"
            placeholder="Template name"
            value={templateName}
            onChange={(e) => onTemplateName(e.target.value)}
          />
        </label>
        <TpButton
          variant="secondary"
          type="button"
          disabled={saving || !canSave}
          onClick={onSave}
        >
          {saving ? "Saving…" : "Save as template"}
        </TpButton>
      </div>

      {message && <p className="app-muted">{message}</p>}
    </>
  );
}
