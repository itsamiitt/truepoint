// TemplateEditor - write or edit an email/LinkedIn template. `templateId: null` is create mode.
//
// A content change appends an immutable version rather than overwriting, which is why the editor and the
// version history are two separate surfaces.
import { TemplateEditor } from "@leadwolf/ui";
import { Stage } from "./_webPage";

/** Create a new template. */
export const Create = () => (
  <Stage height={700}>
    <TemplateEditor templateId={null} open onClose={() => {}} onSaved={() => {}} />
  </Stage>
);

/** Edit an existing one. */
export const Edit = () => (
  <Stage height={700}>
    <TemplateEditor templateId="tp_01" open onClose={() => {}} onSaved={() => {}} />
  </Stage>
);
