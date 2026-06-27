// billing/page.tsx — the thin App Router route for the credit-economics dashboard. Behavior lives in the
// feature slice (features/billing); this file only mounts its public component inside the (shell) chrome.
import { BillingEconomicsPage } from "@/features/billing";

export default function Page() {
  return <BillingEconomicsPage />;
}
