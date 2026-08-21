// datasets/page.tsx — the packaged flat-file catalogue.

import { DatasetsPage } from "@/features/datasets/index.ts";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Datasets",
  description:
    "Cleaned, verified, monthly-refreshed datasets delivered as CSV and JSON — for teams who want the list rather than the API.",
};

export default function DatasetsRoute() {
  return <DatasetsPage />;
}
