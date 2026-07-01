// (shell)/notifications/page.tsx — the full notification history route (G-NTF-1). Thin: all behavior lives in
// the feature slice (features/notifications); the top-bar bell's "See all" deep-links here.
import { NotificationsPage } from "@/features/notifications";

export default function NotificationsRoute() {
  return <NotificationsPage />;
}
