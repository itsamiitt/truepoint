# 13 — Security

> **Priority:** P0 · **Effort:** 7–10 eng-weeks (staged; excludes outside counsel) · **Phase:** F1 → F3
> (phases defined in `17-phased-implementation-roadmap.md`). Cite problems as **P-01.x** from
> `01-current-architecture-audit.md`.

## Executive summary

This is the security verdict on Forge. Per the platform's own precedence rule, **security has the
final say on whether something is safe** — on any access-control, isolation, secret, PII, or
compliance point in this suite, the positions here override convenience and structure arguments in
sibling documents. The central finding is that the write path protecting Forge's golden layer is
**trust-inverted**: the four-eyes promotion gate is client-assertable (P-01.10), promotion accepts
client-supplied content hashes, fields, and confidence (P-01.11), the capture edge accepts any
authenticated platform user token (P-01.15) and any client-declared byte count (P-01.13), and the
globally unique content-hash dedup key admits cross-tenant poisoning and an existence oracle
(P-01.12). Beneath that, the data layer stores raw LinkedIn PII as plaintext despite a config
comment claiming column encryption, ships a deterministic default HMAC key (P-01.14), has no RLS
backstop (P-01.24), and runs every Forge process on the owner DSN (P-01.22) — and none of this is
caught, because there are no forge security/isolation tests in CI (P-01.28).

None of this is exploitable in production **today**, because capture and sync are dark
(`FORGE_CAPTURE_ENABLED`/`FORGE_SYNC_EGRESS_ENABLED` default off, `packages/config/src/forge.ts:24-38`)
and the extension does not yet feed Forge. That is the entire security argument for the roadmap:
**fix the write path in F1, before the flags flip.** The one strategic security-and-compliance
decision — whether to adopt MAIN-world raw-API interception (ADR-0046) — should be resolved
**against** interception-as-primary; the visible-DOM capture the extension does today is the
survivable posture (`07-data-governance.md`).

## Current state

- **AuthN is sound in shape.** forge-api verifies the platform access JWT against the shared-IdP
  JWKS with the `APP_ORIGINS` audience and resolves staff per-request from `platform_staff`
  (`apps/forge-api/src/middleware/auth.ts:14-52`), so revocation is immediate. The console uses PKCE
  + in-memory tokens + silent refresh, holds no secrets, and has no cookie on its own origin (no
  CSRF surface on `/bff/*`). The extension companion-window auth (ADR-0045, extension-scoped tokens,
  `aud=chrome-extension://<id>`) is a correct isolation design.
- **AuthZ is capability-based** (`data:read|manage|review|export`; `data_ops` gets all;
  `super_admin` implies) and enforced per BFF route (`dashboard-bff/routes.ts`), tested
  (`apps/forge-api/test/bff.test.ts`).
- **But the write path trusts the client**, the data layer is unencrypted and un-RLS'd, credentials
  are shared, and `/metrics`/`/ready`/`/live` are unauthenticated and publicly routed via
  `forge-api.truepoint.in` (`deploy/Caddyfile:84-86`).

## Problems identified

The write-path and isolation defects are enumerated canonically in doc 01; this document adopts
those IDs and adds the security-specific framing.

- **P-13.1 (= P-01.10) — RISK · Four-eyes is client-assertable.** `requestedByUserId` (the "maker")
  comes from the request body (`apps/forge-api/src/features/review/schema.ts:20-22`); the only check
  is body-maker ≠ authenticated approver (`packages/forge-core/src/verification.ts:108`).
  `forge.approval_requests` is never inserted, so the DB `CHECK (decided_by <> requested_by)`
  (`0070_forge_schema.sql:198`) never engages. **Any single `data:review` operator can promote
  arbitrary self-authored records into the only layer that syncs to the master graph.**
- **P-13.2 (= P-01.11) — RISK · Promotion trusts content, hash, and confidence.** `contentHash` is
  validated as `min(1)` not 64-hex, `fields` is `z.unknown()`, and the 0.8 confidence gate operates
  on a client-supplied number (`verification.ts:116`). No linkage ties the candidate to
  `parsed_records`/`extraction_runs`.
- **P-13.3 (= P-01.12) — RISK · Global content-hash → cross-tenant poisoning + existence oracle.**
  `content_hash` is never recomputed server-side and is globally unique (`0070:28`); junk landed
  under a legitimate payload's hash blocks any later genuine capture (any tenant) and the
  `duplicate` count leaks whether another tenant holds a given payload.
- **P-13.4 (= P-01.13) — RISK · Client-declared byte counts drive caps, rate limits, and storage
  routing** (`captures/routes.ts:49-54`, `ingest.ts:94`); a false `byteSize` defeats all three.
- **P-13.5 (= P-01.15) — RISK · The capture principal is unscoped.** `resolveCaller` accepts any
  valid access token with a `tid` (`auth.ts:55-60`).
- **P-13.6 (= P-01.14/P-01.6) — RISK · Deterministic default HMAC key + broken blind-index seam.**
  `FORGE_BLIND_INDEX_KEY` falls back to the committed literal `"forge-dev-blind-index-key"`
  (`packages/config/src/forge.ts:41`); the seam to the master graph decodes hex as base64 under a
  different key (`forgeSyncRepository.ts:63-65`), so blind indexes are both forgeable and
  non-matching.
- **P-13.7 (= P-01.22) — RISK · Nominal credential isolation.** Every forge process connects with the
  owner DSN and drops to `leadwolf_forge` via `SET LOCAL ROLE` (`client.ts:70-75`) — owner
  credentials are held at all times; the wall is process discipline.
- **P-13.8 (= P-01.24) — RISK · No RLS in the forge schema.** Isolation rests entirely on grants; a
  future misgrant or an owner-role query has no row-level backstop, and past bronze there is no
  tenant column to filter on.
- **P-13.9 — RISK · Raw PII stored plaintext.** `raw_captures.payload_inline` is `text` with no
  column encryption despite the config comment (`packages/config/src/forge.ts:6`); S3 offload sets
  no SSE-KMS despite its comment (`forgeObjectStore.ts`).
- **P-13.10 — RISK · Unauthenticated public telemetry/health.** `/metrics`, `/ready`, `/live` are
  open and internet-routable (`app.ts:16-19`, `Caddyfile:84-86`).
- **P-13.11 (= P-01.9) — RISK · Dormant privileged ingress.** `POST /api/v1/master-sync` is always
  mounted with a bespoke machine-auth chain no caller exercises and no test covers.
- **P-13.12 (= P-01.28) — RISK · No isolation/security tests.** Cross-role isolation, four-eyes
  enforcement, and dedup poisoning are all unverified in CI.
- **P-13.13 (= P-01.30) — RISK · The interception decision is unresolved and pointed the wrong way.**
  ADR-0046 (MAIN-world raw-API interception) reverses ADR-0043 #4 and the founder brief and is the
  corpus's own ESCALATE item.

## Research findings

- **Scraping / interception law now favors the visible-DOM posture.** EDPB Guidelines 03/2026
  (adopted 2026-07-07) treat login walls, CAPTCHAs, and robots.txt as factors in the "reasonable
  expectations" balancing test ([EDPB PDF](https://www.edpb.europa.eu/system/files/2026-07/edpb_guidelines_2020603_webscraping_v1_en_0.pdf)),
  and the LinkedIn v. Proxycurl action (Jan 2025) ended with Proxycurl **shut down by July 2025**
  ([StartupHub](https://www.startuphub.ai/ai-news/startup-news/2025/the-1-linkedin-scraping-startup-proxycurl-shuts-down)).
  CFAA is a weak threat for public data (hiQ), but **contract/ToS claims are lethal**. Capturing only
  what the logged-in user already sees, user-initiated, with no fake accounts or bulk automation, is
  the survivable design; MAIN-world raw-API interception inherits Proxycurl's risk profile.
- **Blind indexes must be keyed HMACs in a KMS, not bare hashes.** Unsalted email hashes are
  dictionary-reversible; the standard is HMAC-SHA256 with the key in a KMS and rotation
  ([Schnell et al. PPRL](https://pmc.ncbi.nlm.nih.gov/articles/PMC2753305/)) — Forge's committed
  default key defeats this.
- **Access governance for internal data tooling** is RBAC for coarse roles + ABAC conditions
  (maker≠checker as an owner-equality predicate), plus **break-glass** (pre-authorized, time-limited,
  logged, alert-on-use) and **purpose-based access** (log *why* PII was read), which maps to GDPR
  purpose limitation and SOC 2 evidence expectations ([Apono break-glass](https://www.apono.io/wiki/break-glass-scenarios/)).

## Enterprise best practices

A ZoomInfo/Apollo-class platform treats the ingestion/promotion path as a hostile boundary: the
server derives every authorization-relevant value (never the client), the golden-record write is
gated by an enforced separation-of-duties, every identity key is a KMS-managed keyed hash, tenant
isolation has a database backstop (RLS) not just application discipline, PII at rest is encrypted,
internal tooling logs purpose on every PII read, and the whole path is isolation-tested in CI so a
refactor cannot silently open a cross-tenant hole. Forge has the *shape* of several of these (the
capability model, the DB `CHECK`, the audit chain) but none are yet load-bearing.

## Recommended architecture

**1. Make the write path server-authoritative (F1).**
- Insert `forge.approval_requests` in the maker step, derive the maker from pipeline state/session,
  and let the DB `CHECK` enforce four-eyes. The approve endpoint takes only an `approvalRequestId`
  and the approver's verified identity — never `requestedByUserId`, `fields`, or `confidence` from
  the body. Candidate fields and confidence come from the persisted extraction record.
- Recompute `content_hash` server-side over a canonical serialization and **measure** payload bytes;
  reject envelopes whose declared hash/size disagree.
- Introduce a **per-tenant capture claim**: keep global content-addressed storage but add
  `forge.capture_claims UNIQUE (tenant_id, content_hash)`, so `duplicate` is reported only within the
  caller's own tenant (closes the oracle and the poisoning, P-13.3) and attribution is per-tenant.
- Scope the capture principal to a dedicated capture token/scope, not any user token (P-13.5).

The four-eyes fix, concretely. The current handler trusts the body for the maker and the candidate:

```ts
// BEFORE — apps/forge-api/src/features/review/routes.ts:20-51 (vulnerable)
app.post("/v1/review/approve", async (c) => {
  const staff = await deps.resolveStaff(c);                 // the authenticated *approver*
  if (!hasCapability(staff, "data:review")) return forbidden();
  const parsed = approvePromotionRequest.safeParse(await c.req.json());
  const result = await approvePromotion({ promote: deps.promote }, {
    id:                parsed.data.approvalRequestId,
    requestedByUserId: parsed.data.requestedByUserId,       // ← MAKER FROM THE BODY (P-13.1)
    candidates:        parsed.data.candidates.map((cand) => ({ ...cand, fields: cand.fields ?? null })),
    //                 ^ fields + confidence ALSO from the body (P-13.2)
  }, staff.userId);                                          // check: body-maker !== approver — trivially satisfied
  return Response.json(result, { status: 200 });
});
```

```ts
// AFTER — the maker and the candidate come from server state, never the client
app.post("/v1/review/approve", async (c) => {
  const approver = await deps.resolveStaff(c);
  if (!hasCapability(approver, "data:review")) return forbidden();
  const { approvalRequestId } = approveSchema.parse(await c.req.json());   // the ONLY client input
  const result = await withForgeTx(async (tx) => {
    const req = await loadApprovalRequest(tx, approvalRequestId);          // maker = req.requested_by_user_id (server-set)
    if (!req || req.status !== "pending") return notFound();
    if (req.requested_by_user_id === approver.userId) throw new FourEyesViolationError();
    const candidate = await loadCandidate(tx, req.subject_ref);            // fields + confidence from parsed_records/extraction_candidates
    if (candidate.confidence < VERIFY_THRESHOLD) return rejected();        // pipeline confidence, not client's
    return promoteVerifiedRecord(tx, { approvalRequestId, approver: approver.userId, candidate });
  });                                                                       // UPDATE approval_requests SET decided_by=approver
  return Response.json(result, { status: 200 });                           // → the 0070:198 CHECK now engages
});
```

The maker row is written by the **pipeline** at review-task creation, so the checker literally cannot be
the maker:

```sql
-- verify stage (worker) inserts the request; the maker is the system/pipeline actor, not a human client
INSERT INTO forge.approval_requests (op_class, requested_by_user_id, payload)
VALUES ('promote_verified', :pipeline_actor_id, jsonb_build_object('subject_ref', :raw_capture_id));
-- promotion UPDATE (the approver step) now matches a real row, and the CHECK is load-bearing:
--   CONSTRAINT approval_requests_four_eyes CHECK (decided_by_user_id IS NULL OR decided_by_user_id <> requested_by_user_id)  (0070:198)
```

Per-tenant capture claim + server-side hash (kills the oracle, poisoning, and size spoof — P-13.3/4):

```sql
-- keep global content-addressed storage (raw_captures.content_hash UNIQUE, 0070:28) for dedup of bytes,
-- but attribute and report duplicates PER TENANT so one tenant can neither poison nor probe another:
CREATE TABLE forge.capture_claims (
  tenant_id     uuid NOT NULL,
  content_hash  char(64) NOT NULL,
  claimed_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uniq_capture_claim UNIQUE (tenant_id, content_hash)   -- duplicate is per-tenant, not global
);
-- RLS so a tenant sees only its own claims:
ALTER TABLE forge.capture_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE forge.capture_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY claim_isolation ON forge.capture_claims
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
```

```ts
// server RECOMPUTES the hash and MEASURES bytes — the client's declared values are ignored for trust
const raw = await c.req.arrayBuffer();                       // measured, not envelope.size
if (raw.byteLength > ENVELOPE_MAX_BYTES) return payloadTooLarge();
const contentHash = createHash("sha256").update(canonicalize(raw)).digest("hex");   // never trust record.contentHash
const dup = await claimForTenant(tx, session.tenantId, contentHash);  // ON CONFLICT (tenant_id, content_hash) DO NOTHING
```

**2. Fix identity secrets (F1).** One KMS-managed blind-index key with rotation, one encoding, one
normalization across the monorepo (`05`/`06`/`16`); hard-fail boot if the key is unset; migrate
Forge's hex indexes to the main-app bytea convention with an identity-match test.

**3. Isolation backstop (F2).** Add RLS to forge tables where tenant-scoped, and carry a
`tenant_id`/claim reference past bronze so there is something to scope on; add the **mandatory
cross-role isolation test** to CI (`leadwolf_forge` cannot read `public`; the app roles cannot read
`forge`; a tenant cannot see another tenant's captures). Move toward **per-service DB credentials**
so a compromised forge process does not hold owner rights (P-13.7).

RLS on tenant-scoped forge tables, following the exact fail-closed `NULLIF` pattern the main app uses
(`packages/db/src/rls/*.sql`), plus the CI isolation test that makes the boundary a property rather than
a hope:

```sql
-- packages/db/src/rls/forge.sql (new) — for every forge table that carries a tenant reference
ALTER TABLE forge.raw_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE forge.raw_captures FORCE  ROW LEVEL SECURITY;   -- applies even to the table owner
CREATE POLICY tenant_isolation ON forge.raw_captures
  USING      (target_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (target_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
-- a missing GUC matches NOTHING (fail-closed), never everything — the platform's tenancy.md invariant
```

```ts
// packages/db/test/forgeIsolation.itest.ts (new) — required, blocks merge
test("leadwolf_forge cannot read public (the compliance firewall)", async () => {
  await expect(withForgeTx((tx) => tx.execute(sql`SELECT 1 FROM public.master_persons LIMIT 1`)))
    .rejects.toThrow(/permission denied/);
});
test("a tenant cannot see another tenant's captures", async () => {
  await seedCapture({ tenant: A, hash: "…" });
  const rows = await withForgeTenantTx(B, (tx) => tx.execute(sql`SELECT * FROM forge.raw_captures`));
  expect(rows).toHaveLength(0);                    // RLS returns zero, not A's row
});
test("promotion four-eyes rejects a self-approval", async () => {
  const req = await createApprovalRequest({ maker: U });
  await expect(approveAs(U, req.id)).rejects.toBeInstanceOf(FourEyesViolationError);
});
```

Until per-service credentials land, the residual risk (P-13.7) is that the forge processes hold the owner
DSN, which is `BYPASSRLS`-adjacent via `SET LOCAL ROLE`; the isolation test above runs under the
non-owner `leadwolf_forge` role precisely so a regression that leaks owner rights is caught.

**4. Data protection (F2).** Move raw payloads to R2 with SSE-KMS (`09`), or column-encrypt
`payload_inline`; never log PII (structured logs, `12`); lock down `/metrics`/`/ready`/`/live` to
internal networks or authenticated scrapers (P-13.10).

**5. STRIDE over the capture → promote → sync path.**

| Threat | Vector today | Control |
|---|---|---|
| **S**poofing | Any user token posts captures (P-13.5); client maker id (P-13.1) | Scoped capture principal; server-derived maker |
| **T**ampering | Client hash/size/fields (P-13.2/3/4) | Server recompute + measure; candidate from pipeline state |
| **R**epudiation | Race-forked audit chain (P-01.18) | Serialized sequence + WORM anchor (`07`) |
| **I**nfo disclosure | Existence oracle (P-13.3); plaintext PII (P-13.9); open /metrics (P-13.10) | Per-tenant claim; encryption at rest; lock telemetry |
| **D**enial of service | Fail-open rate limiter; 128 MB body; in-tx S3 (`14`) | Fail-closed limits; measured caps; batch the land |
| **E**levation | Owner DSN everywhere (P-13.7); no RLS (P-13.8); bypassable four-eyes (P-13.1) | Per-service creds; RLS; enforced four-eyes |

**6. The interception decision (F3, counsel-gated).** Keep ADR-0046 dark; recommend against
MAIN-world raw-API interception as primary; keep the extension on user-visible, user-initiated DOM
capture. Formalize the ADR as amended (interception a research option behind a legal gate, not the
GA path).

## Implementation details

- `apps/forge-api/src/features/review/`: replace the approve schema and handler so the maker is
  server-derived and the candidate is loaded from `forge.extraction_candidates`/`parsed_records`;
  insert `forge.approval_requests` at task creation.
- `apps/forge-api/src/features/captures/routes.ts` + `packages/forge-core/src/ingest.ts`: recompute
  hash, measure bytes, add the `capture_claims` write; scope the capture token in `middleware/auth.ts`.
- `packages/config/src/forge.ts`: move into the validated env schema; hard-fail on missing key.
- `packages/db/src/rls/forge*.sql` (new): RLS policies; `packages/db/test/forgeIsolation.itest.ts`
  (new): the mandatory cross-role/tenant isolation test.
- `deploy/Caddyfile`: restrict `forge-api.truepoint.in` telemetry/health to internal.

## Migration strategy

All F1 write-path fixes ship while capture/sync are dark — no production data is at risk. The
blind-index unification is a dual-gate migration (`19-migration-plan.md`): dual-write both encodings,
backfill, prove parity with the identity-match test, then cut reads over. RLS is added additively and
proven by the isolation test before any tenant data flows.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Flags flip before write-path fixes land | Low | Critical | Gate GA on the F1 security DoD; keep flags off in the deploy template |
| Blind-index migration corrupts master matches | Medium | High | Dual-write + identity-match test before cutover |
| Interception adopted under commercial pressure | Medium | High | Formal ADR amendment; counsel sign-off required; keep dark |

## Success metrics

- Zero client-trusted values on the capture and promotion write paths (audited).
- Four-eyes enforced by an inserted `approval_requests` row + DB `CHECK`; a self-approval test fails
  closed.
- One KMS-managed blind-index key; boot fails without it; identity-match test green.
- Cross-role/tenant isolation test in CI, blocking merge.
- Raw PII encrypted at rest; `/metrics` not publicly reachable.

## Effort & priority

**P0.** The write-path and secret fixes are ~4–5 eng-weeks in F1; RLS/credentials/encryption are
~3–4 eng-weeks in F2; the interception ADR and full SOC 2 evidence are F3. Outside counsel for the
interception decision and the compliance spine is tracked in `07-data-governance.md`.

## Future enhancements

Field-level access controls and purpose-based access logging for the operator console; customer-
managed keys (BYOK) and residency siloing for enterprise tenants (ADR-0021 siloing tier); a formal
threat-model review before each new ingestion source is enabled.
