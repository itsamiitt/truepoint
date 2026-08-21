// pricing/page.tsx — the published price list.

import { PricingPage } from "@/features/pricing/index.ts";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Per-action credit costs and every self-serve plan, published in full. You are charged only when data is returned.",
};

export default function PricingRoute() {
  return <PricingPage />;
}
