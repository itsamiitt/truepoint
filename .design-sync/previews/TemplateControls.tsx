// TemplateControls - save the current column mapping as a reusable template, or apply a saved one.
//
// `canSave` gates the save: an unchanged or incomplete mapping is not worth storing, so the control is
// disabled rather than saving something useless.
import { TemplateControls } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

const base = {
  templates: D.MAPPING_TEMPLATES,
  onApply: () => {},
  onTemplateName: () => {},
  onSave: () => {},
};

/** Two saved templates, with a name typed and the save available. */
export const Saveable = () => (
  <Frame>
    <TemplateControls {...base} templateName="EMEA quarterly" saving={false} canSave message={null} />
  </Frame>
);

/** Nothing worth saving yet - the control is disabled, not hidden. */
export const CannotSave = () => (
  <Frame>
    <TemplateControls {...base} templateName="" saving={false} canSave={false} message={null} />
  </Frame>
);

/** Saving. */
export const Saving = () => (
  <Frame>
    <TemplateControls {...base} templateName="EMEA quarterly" saving canSave message={null} />
  </Frame>
);

/** Saved, with the confirmation the control reports inline. */
export const Saved = () => (
  <Frame>
    <TemplateControls {...base} templateName="EMEA quarterly" saving={false} canSave={false} message="Template saved" />
  </Frame>
);

/** No templates saved yet - apply has nothing to offer. */
export const NoTemplates = () => (
  <Frame>
    <TemplateControls {...base} templates={[]} templateName="" saving={false} canSave={false} message={null} />
  </Frame>
);
