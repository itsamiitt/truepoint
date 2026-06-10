# departments/04 — Marketing

> The demand-gen / ABM persona: build target-account universes, watch intent, enrich for campaigns, and
> attribute pipeline. Framework: [25](../25-departments-teams-workspaces.md).

## 1. Purpose & users
Marketing runs account-based programs: define ICP/target lists, monitor intent, enrich audiences, and feed
sales. **Users:** Demand-gen / ABM / Ops marketers. `department_type = marketing`.

## 2. Persona & surfaces (6 destinations)
- **Home** → ABM dashboard (§3). **Prospect** → ICP/segment builder, intent + technographic filters,
  smart segments (`24`). **Reports** → program/attribution pack. (Sending is via Sales/SDR or export to
  the MAP/CRM, `26`.)

## 3. Dashboard & KPIs
Target-account coverage, intent surges by account, segment sizes, enrichment fill-rate, MQL→SQL handoff,
program-influenced pipeline, data freshness on audiences.

## 4. Workflows & automations (`27`)
- **Intent alerts**: account intent surge → notify owner + add to play/list.
- **Audience sync**: smart segment → reverse-ETL to MAP/ads (`26`).
- **Enrichment-on-entry**: new list members auto-enriched (`06`), held to quality bar (`22`).
- **Lead routing** of inbound to SDR/AE by ICP fit + territory.

## 5. Permissions, visibility & budgets
Marketers: build segments, enrich, export/sync; typically **no individual reveal-send** (export to systems
of action). Reveal/enrich spend under **per-team budget**; manager views for program owners.

## 6. Reporting
Account-coverage, intent trends, segment health, enrichment economics, attribution (influenced/sourced);
ClickHouse-backed.

## 7. Collaboration
Shared ICP/segments with Sales/SDR/BDR, intent hand-offs, alignment dashboards; audience exports to CRM/MAP.

## Links
- **Links to:** [25](../25-departments-teams-workspaces.md), [24](../24-advanced-search-exploration-ux.md),
  [27](../27-workflow-automation-engine.md), [26](../26-integrations-data-delivery.md), [06 §2](../06-enrichment-engine.md),
  [22](../22-data-quality-freshness-lifecycle.md)
- **Linked from:** [25 §9](../25-departments-teams-workspaces.md), [departments/README](./README.md)
