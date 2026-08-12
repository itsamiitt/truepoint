// The Explorer: one organization view that makes the develops-vs-uses split
// visible. Two side-by-side panels, never one merged list — the UI encodes the
// same distinction the schema and the API enforce.
//
// Vanilla TS + DOM. No framework: the surface is one screen, and a build step
// would obscure how little is happening here.

import { ApiError, type EvidenceDto, type OrganizationDto, type TechEdgeDto, api } from "./api";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const state: { org: OrganizationDto | null; asOf: string } = { org: null, asOf: "" };

function confidenceBand(c: number): { label: string; cls: string } {
  if (c >= 0.85) return { label: "high", cls: "band-high" };
  if (c >= 0.6) return { label: "medium", cls: "band-med" };
  return { label: "low", cls: "band-low" };
}

function daysSince(iso: string | null): string {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
}

function edgeCard(edge: TechEdgeDto): string {
  const band = confidenceBand(edge.confidence);
  const isUse = edge.relationship === "uses";
  const detail = isUse
    ? `<div class="meta">
         <span title="Detection method">${edge.detection_method ?? "unknown method"}</span>
         <span title="Where the fingerprint fired">${edge.detected_on_domain ?? ""}</span>
         <span title="Last detected">seen ${daysSince(edge.last_seen_at)}</span>
       </div>`
    : `<div class="meta">
         ${edge.is_primary_product ? '<span class="flagship">flagship</span>' : ""}
         <span>${edge.technology.category_path ?? ""}</span>
       </div>`;
  const creator = edge.creator
    ? `<div class="creator">built by <strong>${edge.creator.display_name ?? edge.creator.legal_name}</strong></div>`
    : "";
  return `
    <li class="card">
      <div class="card-head">
        <span class="name">${edge.technology.canonical_name}</span>
        <button class="band ${band.cls}" data-evidence="${edge.rel_id}" title="Show the evidence behind this fact">
          ${band.label} · ${edge.confidence.toFixed(2)}
        </button>
      </div>
      ${detail}
      ${creator}
    </li>`;
}

async function renderOrg(orgId: string) {
  const panel = $("#panels");
  panel.innerHTML = `<p class="loading">Loading…</p>`;
  try {
    const [{ organization }, built, runs] = await Promise.all([
      api.organization(orgId),
      api.technologies(orgId, "develops", { asOf: state.asOf || undefined }),
      api.technologies(orgId, "uses", { asOf: state.asOf || undefined, withVendors: true }),
    ]);
    state.org = organization;

    const [people, alumni] = await Promise.all([
      api.peopleAt(orgId).catch(() => ({ results: [] })),
      organization.org_kind === "school" ? api.alumniOf(orgId) : Promise.resolve({ results: [] }),
    ]);

    $("#org-title").textContent = organization.display_name ?? organization.legal_name;
    $("#org-sub").textContent =
      `${organization.org_kind} · ${organization.primary_domain ?? "no domain"}`;

    panel.innerHTML = `
      <section class="panel develops">
        <h2>Builds <span class="count">${built.results.length}</span></h2>
        <p class="hint">Products this organization develops or sells.</p>
        <ul>${built.results.map(edgeCard).join("") || '<li class="empty">Nothing recorded.</li>'}</ul>
      </section>
      <section class="panel uses">
        <h2>Runs <span class="count">${runs.results.length}</span></h2>
        <p class="hint">Third-party technology detected in use. Never its own products.</p>
        <ul>${runs.results.map(edgeCard).join("") || '<li class="empty">Nothing detected.</li>'}</ul>
      </section>
      <section class="panel people">
        <h2>${organization.org_kind === "school" ? "Alumni" : "People"} <span class="count">${
          organization.org_kind === "school" ? alumni.results.length : people.results.length
        }</span></h2>
        <ul>${
          organization.org_kind === "school"
            ? alumni.results
                .map(
                  (a) =>
                    `<li class="card"><div class="card-head"><span class="name">${a.person.full_name}</span></div>
                     <div class="meta"><span>${a.education.degree ?? ""}</span><span>class of ${a.education.ended_year ?? "—"}</span></div></li>`,
                )
                .join("")
            : people.results
                .map(
                  (p) =>
                    `<li class="card"><div class="card-head"><span class="name">${p.person.full_name}</span></div>
                     <div class="meta"><span>${p.position.title ?? ""}</span></div></li>`,
                )
                .join("")
        }${
          (organization.org_kind === "school" ? alumni.results : people.results).length === 0
            ? '<li class="empty">Nobody recorded.</li>'
            : ""
        }</ul>
      </section>`;

    for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-evidence]")) {
      btn.addEventListener("click", () => showEvidence(btn.dataset.evidence as string));
    }
  } catch (err) {
    panel.innerHTML = `<p class="error">${
      err instanceof ApiError
        ? `${err.problem.title}${err.problem.detail ? ` — ${err.problem.detail}` : ""}`
        : String(err)
    }</p>`;
  }
}

async function showEvidence(edgeId: string) {
  const dialog = $<HTMLDialogElement>("#evidence");
  const body = $("#evidence-body");
  body.innerHTML = `<p class="loading">Loading evidence…</p>`;
  dialog.showModal();
  try {
    const ev: EvidenceDto = await api.evidence(edgeId);
    body.innerHTML = `
      <p class="fused">Fused confidence <strong>${ev.fused_confidence.toFixed(3)}</strong>
        from ${ev.attestations.length} independent sighting${ev.attestations.length === 1 ? "" : "s"}.</p>
      <ul class="attestations">
        ${ev.attestations
          .map(
            (a) => `<li>
              <div class="att-head"><span class="src">${a.source_class.replace(/_/g, " ")}</span>
                <span class="att-conf">${a.confidence.toFixed(2)}</span></div>
              ${a.raw_assertion ? `<blockquote>${a.raw_assertion}</blockquote>` : ""}
              <div class="seen">seen ${new Date(a.seen_at).toISOString().slice(0, 10)}</div>
            </li>`,
          )
          .join("")}
      </ul>`;
  } catch (err) {
    body.innerHTML = `<p class="error">${err instanceof ApiError ? err.problem.title : String(err)}</p>`;
  }
}

async function search(term: string) {
  const results = $("#results");
  if (!term.trim()) {
    results.innerHTML = "";
    return;
  }
  try {
    const { matches } = await api.identifyOrganization(term);
    results.innerHTML = matches.length
      ? matches
          .map(
            (m) =>
              `<button class="result" data-org="${m.organization.org_id}">
                 <span>${m.organization.display_name ?? m.organization.legal_name}</span>
                 <span class="match">${(m.match_confidence * 100).toFixed(0)}% match</span>
               </button>`,
          )
          .join("")
      : `<p class="empty">No organization matches “${term}”.</p>`;
    for (const btn of results.querySelectorAll<HTMLButtonElement>("[data-org]")) {
      btn.addEventListener("click", () => {
        results.innerHTML = "";
        $<HTMLInputElement>("#search").value = "";
        void renderOrg(btn.dataset.org as string);
      });
    }
  } catch (err) {
    results.innerHTML = `<p class="error">${err instanceof ApiError ? err.problem.title : String(err)}</p>`;
  }
}

export function mount(seedOrgId: string) {
  let timer: ReturnType<typeof setTimeout>;
  $<HTMLInputElement>("#search").addEventListener("input", (e) => {
    clearTimeout(timer);
    const value = (e.target as HTMLInputElement).value;
    timer = setTimeout(() => void search(value), 200);
  });

  $<HTMLInputElement>("#as-of").addEventListener("change", (e) => {
    state.asOf = (e.target as HTMLInputElement).value;
    if (state.org) void renderOrg(state.org.org_id);
  });

  $("#evidence-close").addEventListener("click", () => $<HTMLDialogElement>("#evidence").close());

  void renderOrg(seedOrgId);
}
