// datasets/[slug]/page.tsx — one dataset's field list and illustrative rows.
//
// generateStaticParams prerenders every dataset at build time and, with dynamicParams off, an unknown slug
// is a 404 rather than a request that reaches the server. On a site with no database that is the whole
// request surface: there is nothing to enumerate and nothing to probe.

import { DATASETS, findDataset } from "@/content/datasets.ts";
import { DatasetPage } from "@/features/datasets/index.ts";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const dynamicParams = false;

export function generateStaticParams() {
  return DATASETS.map((dataset) => ({ slug: dataset.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const dataset = findDataset(slug);
  if (!dataset) return {};
  return { title: dataset.name, description: dataset.summary };
}

export default async function DatasetRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dataset = findDataset(slug);
  if (!dataset) notFound();
  return <DatasetPage dataset={dataset} />;
}
