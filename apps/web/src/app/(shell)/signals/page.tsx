// (shell)/signals/page.tsx — the Signals route (market-intelligence MI-P2). Thin: all behavior lives in
// the feature slice (features/signals); account_signal notifications deep-link here.
import { SignalsPage } from "@/features/signals";

export default function SignalsRoute() {
  return <SignalsPage />;
}
