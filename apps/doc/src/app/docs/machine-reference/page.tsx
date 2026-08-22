// docs/machine-reference/page.tsx — the human page for /llms.txt. Inherits the /docs sidebar frame.

import { MachineReferencePage } from "@/features/machine-reference/index.ts";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Machine reference",
  description:
    "The whole TruePoint data API contract as one plain-text document, generated from the same source as these pages — for assistants, agents and build steps.",
};

export default function MachineReferenceRoute() {
  return <MachineReferencePage />;
}
