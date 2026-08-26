// docs/playground/page.tsx — the simulated API console. Inherits the /docs sidebar frame from the layout.

import { PlaygroundPage } from "@/features/playground/index.ts";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Playground",
  description:
    "Compose a call to either company endpoint and see the exact status, body and charge your integration would receive — simulated against fabricated sample records.",
};

export default function PlaygroundRoute() {
  return <PlaygroundPage />;
}
