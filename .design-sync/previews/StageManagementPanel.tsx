// StageManagementPanel — the workspace's pipeline-stage editor (pipeline settings). Each stage declares
// the canonical outreach_status it rolls up to, so the funnel stays comparable across workspaces that name
// their stages differently. Takes no props: it owns its own load/create/edit against /pipeline-stages.
import { StageManagementPanel } from "@leadwolf/ui";
import { Shell, pad } from "./_prospectShell";

/** The six configured stages, ordered, with the default marked and the inline "add stage" row. */
export const Stages = () => (
  <Shell>
    <div style={{ ...pad, maxWidth: 640 }}>
      <StageManagementPanel />
    </div>
  </Shell>
);
