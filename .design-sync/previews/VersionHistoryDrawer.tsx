// VersionHistoryDrawer - the immutable version history of one template, with restore.
//
// `canEdit` gates restore: a viewer sees the history but cannot roll the template back.
import { VersionHistoryDrawer } from "@leadwolf/ui";
import { Stage } from "./_webPage";

/** An editor viewing history, able to restore. */
export const Editable = () => (
  <Stage height={620}>
    <VersionHistoryDrawer
      templateId="tp_01"
      canEdit
      currentVersion={4}
      open
      onClose={() => {}}
      onRestored={() => {}}
    />
  </Stage>
);

/** A viewer: the same history, no restore. */
export const ReadOnly = () => (
  <Stage height={620}>
    <VersionHistoryDrawer
      templateId="tp_01"
      canEdit={false}
      currentVersion={4}
      open
      onClose={() => {}}
      onRestored={() => {}}
    />
  </Stage>
);
