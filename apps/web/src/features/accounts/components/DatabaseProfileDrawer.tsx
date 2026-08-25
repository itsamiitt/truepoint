// DatabaseProfileDrawer.tsx — the two GLOBAL profile drawers (search-consolidation stage 3): the full
// masked Layer-0 detail of a person or a company, opened straight from a search row WITHOUT first adding
// the record to a workspace.
//
// WHAT IS DELIBERATELY ABSENT. No owner, stage, tags, activity timeline, notes or reveal state — and no
// email or phone VALUE. Those are not omissions to fill in later: a global record has no workspace-scoped
// facts (Layer 0 has no workspace column), and the channel values are the paid product, revealed only once
// the record is in the workspace. `hasEmail`/`hasPhone`/`hasMobile` show that data EXISTS; the primary
// action turns the row into a workspace contact, after which the ordinary owned-record drawer takes over.
//
// This module is loaded through next/dynamic (see SearchProfileHost) — it is only reachable on a row click,
// so it has no business in the Search route's first load.
"use client";

import { Avatar, Drawer, EmptyState, StateSwitch, TpButton, TpChip } from "@leadwolf/ui";
import { useQuery } from "@tanstack/react-query";
import { Building2, ExternalLink, UserX } from "lucide-react";
import styles from "../accounts.module.css";
import { fetchDatabaseCompanyProfile, fetchDatabasePersonProfile } from "../databaseProfileApi";

/** Profile reads are cheap, bounded and change slowly — hold them long enough that reopening a row the user
 *  just looked at is instant rather than a round trip (the PA-8 query-hygiene posture). */
const PROFILE_QUERY_OPTS = { staleTime: 5 * 60_000, gcTime: 10 * 60_000, retry: 1 } as const;

function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.fieldValue}>{value}</span>
    </div>
  );
}

/** The shared "this data exists, revealing it is a separate, paid, workspace-scoped action" row. */
function PresenceChips({
  hasEmail,
  hasPhone,
  hasMobile,
}: {
  hasEmail: boolean;
  hasPhone: boolean;
  hasMobile?: boolean;
}) {
  return (
    <div className={styles.presenceRow}>
      <TpChip active={hasEmail}>{hasEmail ? "Email on file" : "No email"}</TpChip>
      <TpChip active={hasPhone}>{hasPhone ? "Phone on file" : "No phone"}</TpChip>
      {hasMobile ? <TpChip active>Mobile</TpChip> : null}
    </div>
  );
}

/** A single date as the profile shows it ("12 Mar 2026"), null when the source never said. */
function profileDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Enum token → label ("c_suite" → "C suite"). Local rather than imported from the prospect slice: this
 *  feature already sits at the cross-feature import budget (lint:cross-feature is a ratchet). */
function humanize(v: string | null): string | null {
  if (!v) return null;
  return v.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** A date range as the profile shows it. Null start means the source never said — not "year zero". */
function period(startedOn: string | null, endedOn: string | null): string {
  const year = (d: string | null) => (d ? d.slice(0, 4) : null);
  const from = year(startedOn);
  const to = year(endedOn);
  if (!from && !to) return "Dates unknown";
  return `${from ?? "?"} – ${to ?? "Present"}`;
}

export function DatabasePersonProfileDrawer({
  slug,
  onClose,
  onAddToWorkspace,
}: {
  slug: string;
  onClose: () => void;
  onAddToWorkspace: (slug: string) => void;
}) {
  const q = useQuery({
    queryKey: ["search", "database", "people", "profile", slug],
    queryFn: ({ signal }) => fetchDatabasePersonProfile(slug, signal),
    ...PROFILE_QUERY_OPTS,
  });
  const p = q.data?.person;

  return (
    <Drawer open onClose={onClose} width={480} side="right" title={p?.fullName ?? "Profile"}>
      <StateSwitch
        loading={q.isPending}
        error={q.error ? "This profile is not available." : null}
        empty={false}
        onRetry={() => void q.refetch()}
        emptyState={<EmptyState icon={<UserX size={28} />} title="Not available" description="" />}
      >
        {p ? (
          <div className={styles.profileBody}>
            <div className={styles.profileHead}>
              <Avatar name={p.fullName ?? "?"} size={44} />
              <div>
                <div className={styles.profileName}>{p.fullName}</div>
                <div className={styles.profileSub}>{p.jobTitle ?? p.headline ?? "—"}</div>
                <div className={styles.profileSub}>
                  {[p.companyName, p.locationRaw].filter(Boolean).join(" · ") || "—"}
                </div>
              </div>
            </div>

            <PresenceChips
              hasEmail={p.hasEmail}
              hasPhone={p.hasPhone}
              hasMobile={q.data?.hasMobile}
            />

            {/* The masked row already carried all of this and the drawer showed none of it — seniority, the
                resolved city/country (rather than only the raw location string in the header), the employer's
                domain and industry, and when the graph last learned anything about the record. */}
            <div className={styles.fieldGrid}>
              <Field label="Seniority" value={humanize(p.seniorityLevel)} />
              <Field
                label="Location"
                value={[p.locationCity, p.locationCountry].filter(Boolean).join(", ") || null}
              />
              <Field label="Company domain" value={p.companyDomain} />
              <Field label="Industry" value={p.companyIndustry} />
              <Field label="Last updated" value={profileDate(p.updatedAt)} />
            </div>

            <div className={styles.profileActions}>
              {p.inWorkspace ? (
                <TpChip active>In your workspace</TpChip>
              ) : (
                <TpButton size="sm" onClick={() => onAddToWorkspace(slug)}>
                  Add to workspace
                </TpButton>
              )}
              <a
                className={styles.marketsLink}
                href={p.linkedinUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open profile <ExternalLink size={12} />
              </a>
            </div>

            {q.data && q.data.employment.length > 0 ? (
              <section className={styles.profileSection}>
                <h3 className={styles.profileSectionTitle}>Experience</h3>
                {q.data.employment.map((e, i) => (
                  <div
                    // Index-suffixed: two roles at the same company with the same title and no known start
                    // (the bare-edge case the import path mints) collided on the composite key alone.
                    key={`${e.companyName ?? "?"}-${e.startedOn ?? "?"}-${e.title ?? "?"}-${i}`}
                    className={styles.timelineRow}
                  >
                    <div className={styles.fieldValue}>{e.title ?? "—"}</div>
                    <div className={styles.profileSub}>
                      {e.companyName ?? "—"} · {period(e.startedOn, e.endedOn)}
                    </div>
                  </div>
                ))}
              </section>
            ) : null}

            {q.data && q.data.education.length > 0 ? (
              <section className={styles.profileSection}>
                <h3 className={styles.profileSectionTitle}>Education</h3>
                {q.data.education.map((e, i) => (
                  <div
                    // Index-suffixed: two degrees from the same school with the same end year (or two rows
                    // whose dates the source never gave) produced identical keys.
                    key={`${e.schoolName ?? "?"}-${e.endedOn ?? "?"}-${i}`}
                    className={styles.timelineRow}
                  >
                    <div className={styles.fieldValue}>{e.schoolName ?? "—"}</div>
                    <div className={styles.profileSub}>
                      {/* Degree AND dates. The `||` here meant a row with a degree never showed when it was
                          studied, and a row with dates never showed what was studied — each field hid the
                          other rather than both being shown. */}
                      {[e.degree, e.fieldsOfStudy.join(", "), period(e.startedOn, e.endedOn)]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                ))}
              </section>
            ) : null}

            {q.data && q.data.skills.length > 0 ? (
              <section className={styles.profileSection}>
                <h3 className={styles.profileSectionTitle}>Skills</h3>
                <div className={styles.presenceRow}>
                  {q.data.skills.slice(0, 20).map((s) => (
                    <TpChip key={s}>{s}</TpChip>
                  ))}
                </div>
              </section>
            ) : null}

            {q.data && q.data.languages.length > 0 ? (
              <section className={styles.profileSection}>
                <h3 className={styles.profileSectionTitle}>Languages</h3>
                <div className={styles.presenceRow}>
                  {q.data.languages.map((l) => (
                    <TpChip key={l.name}>
                      {l.proficiency ? `${l.name} · ${l.proficiency}` : l.name}
                    </TpChip>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
      </StateSwitch>
    </Drawer>
  );
}

export function DatabaseCompanyProfileDrawer({
  domain,
  onClose,
}: {
  domain: string;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: ["search", "database", "companies", "profile", domain],
    queryFn: ({ signal }) => fetchDatabaseCompanyProfile(domain, signal),
    ...PROFILE_QUERY_OPTS,
  });
  const c = q.data?.company;

  // Headcount GROWTH is derived here from the series, never stored — the 0114 posture. Needs two points a
  // year apart; anything less is not a year-over-year number and is not shown as one.
  const growth = (() => {
    const s = q.data?.headcountSeries ?? [];
    if (s.length < 13) return null;
    const latest = s[s.length - 1];
    const yearAgo = s[s.length - 13];
    if (!latest || !yearAgo || yearAgo.employeeCount === 0) return null;
    return Math.round(
      ((latest.employeeCount - yearAgo.employeeCount) / yearAgo.employeeCount) * 100,
    );
  })();

  return (
    <Drawer open onClose={onClose} width={480} side="right" title={c?.name ?? "Company"}>
      <StateSwitch
        loading={q.isPending}
        error={q.error ? "This company is not available." : null}
        empty={false}
        onRetry={() => void q.refetch()}
        emptyState={
          <EmptyState icon={<Building2 size={28} />} title="Not available" description="" />
        }
      >
        {c ? (
          <div className={styles.profileBody}>
            <div className={styles.profileHead}>
              <Avatar name={c.name} size={44} />
              <div>
                <div className={styles.profileName}>{c.name}</div>
                <div className={styles.profileSub}>{c.primaryDomain}</div>
                <div className={styles.profileSub}>
                  {[c.industryLabel ?? c.industry, c.hqCity, c.hqCountry]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </div>
              </div>
            </div>

            <div className={styles.profileActions}>
              {c.inWorkspace ? <TpChip active>In your workspace</TpChip> : null}
              {c.websiteUrl ? (
                <a
                  className={styles.marketsLink}
                  href={c.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Website <ExternalLink size={12} />
                </a>
              ) : null}
            </div>

            <div className={styles.fieldGrid}>
              <Field label="Headcount" value={c.employeeCount?.toLocaleString() ?? null} />
              <Field label="Size" value={c.employeeBand} />
              <Field
                label="Headcount growth"
                value={growth === null ? null : `${growth > 0 ? "+" : ""}${growth}% YoY`}
              />
              <Field label="Revenue" value={c.revenueDisplay} />
              <Field label="Founded" value={c.yearFounded ? String(c.yearFounded) : null} />
              <Field label="Ownership" value={c.ownershipType} />
            </div>

            {c.description ? (
              <section className={styles.profileSection}>
                <h3 className={styles.profileSectionTitle}>About</h3>
                <p className={styles.profileSub}>{c.description}</p>
              </section>
            ) : null}

            {c.specialties.length > 0 ? (
              <section className={styles.profileSection}>
                <h3 className={styles.profileSectionTitle}>Specialties</h3>
                <div className={styles.presenceRow}>
                  {c.specialties.slice(0, 20).map((s) => (
                    <TpChip key={s}>{s}</TpChip>
                  ))}
                </div>
              </section>
            ) : null}

            {q.data && q.data.locations.length > 0 ? (
              <section className={styles.profileSection}>
                <h3 className={styles.profileSectionTitle}>Locations</h3>
                {q.data.locations.map((l) => (
                  <div
                    key={`${l.kind}-${l.city ?? "?"}-${l.region ?? "?"}`}
                    className={styles.timelineRow}
                  >
                    <div className={styles.fieldValue}>
                      {[l.city, l.region, l.countryCode].filter(Boolean).join(", ") || "—"}
                    </div>
                    <div className={styles.profileSub}>{l.kind}</div>
                  </div>
                ))}
              </section>
            ) : null}
          </div>
        ) : null}
      </StateSwitch>
    </Drawer>
  );
}
