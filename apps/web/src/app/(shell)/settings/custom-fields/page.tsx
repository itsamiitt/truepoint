// Settings ▸ Workspace ▸ Custom fields — mounts the custom-fields management panel (ADR-0028, gap G-REV-5).
import { CustomFieldsPanel } from "@/features/settings-custom-fields";

export default function CustomFieldsSettingsRoute() {
  return <CustomFieldsPanel />;
}
