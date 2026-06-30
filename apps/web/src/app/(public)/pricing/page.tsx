// (public)/pricing/page.tsx — the PUBLIC, unauthenticated transparent pricing page (ADR-0012). It lives in the
// (public) route group (no layout of its own) so it renders under the root layout ONLY — OUTSIDE the (shell)
// AppShell auth gate. No token, no tenant, no balance. All behavior lives in features/public-pricing; this
// thin route just mounts the component and declares page metadata.
import { PublicPricingPage } from "@/features/public-pricing";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "TruePoint pricing — transparent plans and credit packs. You're only charged for verified data, credits never expire, and there's no lock-in.",
};

export default function PricingRoute() {
  return <PublicPricingPage />;
}
