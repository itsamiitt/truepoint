// docs/[slug]/page.tsx — one prose guide. The static `api` segment beneath /docs takes precedence over this
// dynamic one, so the endpoint reference routes are unaffected.

import { GUIDES, findGuide } from "@/content/guides/index.ts";
import { GuidePage } from "@/features/api-reference/index.ts";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const dynamicParams = false;

export function generateStaticParams() {
  return GUIDES.map((guide) => ({ slug: guide.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const guide = findGuide(slug);
  if (!guide) return {};
  return { title: guide.title, description: guide.summary };
}

export default async function GuideRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const guide = findGuide(slug);
  if (!guide) notFound();
  return <GuidePage guide={guide} />;
}
