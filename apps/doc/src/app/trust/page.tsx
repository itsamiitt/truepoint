// trust/page.tsx — the public sourcing and data-ethics statement.

import { TrustPage } from "@/features/trust/index.ts";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Trust and data sourcing",
  description:
    "Where TruePoint data comes from, what we never collect, and how to see, correct or remove your own record.",
};

export default function TrustRoute() {
  return <TrustPage />;
}
