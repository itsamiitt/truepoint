// pricing/page.tsx — the thin App Router route for the credit-pack pricing catalog. Behavior lives in the
// feature slice (features/pricing); this file only mounts its public component inside the (shell) chrome.
import { PricingPage } from "@/features/pricing";

export default function Page() {
  return <PricingPage />;
}
