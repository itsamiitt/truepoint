// Settings ▸ Workspace ▸ Enrichment providers — mounts the waterfall-v2 provider-priority +
// verification panel (settings-enrichment slice, 0111) [S-04][S-08].
import { ProviderPriorityPanel } from "@/features/settings-enrichment";

export default function EnrichmentProvidersSettingsRoute() {
  return <ProviderPriorityPanel />;
}
