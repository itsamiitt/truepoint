// (shell)/settings/billing/page.tsx — the thin App Router route for Billing & Credits (12 §4). All behavior
// lives in the feature slice (features/settings-billing); this file only mounts its public component inside
// the (shell) chrome. The top-bar credit pill deep-links here.
import { BillingPage } from "@/features/settings-billing";

export default function BillingRoute() {
  return <BillingPage />;
}
