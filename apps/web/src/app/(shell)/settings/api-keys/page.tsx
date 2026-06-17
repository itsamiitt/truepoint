// Settings ▸ Developer — mounts the Developer console (API keys · OAuth apps · Webhooks · API docs) behind a
// Tabs switch inside this single page, so no new routes/nav items are added (navConfig stays untouched).
import { DeveloperPage } from "@/features/settings-developer";

export default function DeveloperSettingsRoute() {
  return <DeveloperPage />;
}
