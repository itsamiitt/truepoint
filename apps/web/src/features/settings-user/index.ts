// Public surface of the settings-user feature slice (12 §2) — the three panels the (shell)/settings/* routes
// render: Profile, Security, Notifications. Internals (api/hooks/types) stay private to the slice.
export { ProfilePanel } from "./components/ProfilePanel";
export { SecurityPanel } from "./components/SecurityPanel";
export { NotificationsPanel } from "./components/NotificationsPanel";
