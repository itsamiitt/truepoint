# 13 — Security & Compliance

> **Status of this doc:** complete (design doc — target state 🔲 not built; nothing ships from
> this series). Evidence cites [`01-Current-State-Audit.md`](01-Current-State-Audit.md); gaps cite
> [`02-Root-Cause-and-Gap-Analysis.md`](02-Root-Cause-and-Gap-Analysis.md); every external-platform
> claim cites the register in [`03-Enterprise-Research.md`](03-Enterprise-Research.md).
> **Owns:** **G08** (AV scan is a permanent stub — P0 ❌gate: this doc designs the gate and defines
> "cleared") and **G14** (error artifacts below market + PII posture unaudited — P1: this doc owns
> the PII/redaction/retention/access envelope; doc [`08`](08-Import-Architecture.md) §6.2 owns the
> artifact *contract*). Also owns: the upload-security envelope 08 §pre-build explicitly defers
> here, the sanctioned-bypass audit, the tenant-isolation review of every new endpoint, the SSRF
> forward-guard on 08 §9's extensions, and the DSAR/retention/compliance mapping for import data.
> **Consumes (never re-specs):** 08 §2.3 (verbs), 08 §6.2 (two artifacts), 09 §3/§6 (DLQ + outbox
> PII-free posture), 10 §2/§4/§7 (visibility matrix, predicate, download audit), 05 §2/§7
> (child-table encryption + DSAR fanout), 04 §3 (merge audit).
> **Step IDs:** `S-S1`…`S-S8` (sequenced in doc `15`; never fixed migration numbers).

---

## Objective

Make the redesigned import platform safe to run against hostile input and provable to an auditor:
every uploaded byte is treated as attacker-controlled until validated and scanned; every place
row PII can rest, travel, or leak — staging, the ledger, artifacts, logs, error messages, the DLQ,
event payloads — has one explicitly stated posture; the ONE sanctioned RLS bypass stays the only
one; every new endpoint is tenant-scoped, role-gated, owner-predicated, rate-limited, and audited;
and the import data lifecycle (retention, DSAR, minimization) closes rather than leaks. The two
owned gaps: the permanent `scanUpload()` stub becomes a real, testable malware gate (G08), and the
PII-bearing error artifacts get the full protection envelope the market ships (G14).

---

## Reconciliation (what this design builds on and must never contradict)

Pinned to shipped code and locked decisions before any design claim:

1. **The AV stub, exactly as shipped (01 §3.3):** `scanUpload()` returns `"skipped"` with no
   scanner at the composition root (`apps/api/src/features/import/bulkRoutes.ts:126–128`); the
   refusal path for `"infected"` exists (`bulkRoutes.ts:169–171`); the status column + closed enum
   `pending|clean|infected|skipped` are in place (`packages/db/src/schema/importJobs.ts:50,87–90`).
   Every upload today records `av_scan_status='skipped'`. The seam's own comment promises the
   contract this doc fills: a wired scanner returns `clean`/`infected`, the caller refuses infected
   before any job exists, "and core's promote-to-staging re-checks the gate" (`bulkRoutes.ts:121–125`).
2. **The ciphertext-in-staging rule, stated precisely (design-of-record
   [`../data-management/15-bulk-import-design.md`](../data-management/15-bulk-import-design.md) §1
   and §8).** Channel/identity values are **always ciphertext in staging**: "Staging carries the
   already-prepared row (ciphertext + blind index + content_hash) so PII is encrypted even in
   staging […]" (15 §1); 05 §6 extends the same rule to multi-value channel payloads. **But this doc
   must not claim "no plaintext in staging":** 15 §8 documents the ONE transient-plaintext column —
   "`staging.raw_data` holds plaintext PII transiently (non-RLS UNLOGGED) for `source_imports`
   provenance — REVOKE + DROP-on-complete + the (unbuilt) AV gate." That column is sanctioned,
   bounded (dropped at finalize), and this doc's AV gate is the third leg its risk note names.
3. **The ONE sanctioned RLS bypass (07 §5, quoting 15):** "COPY only fast-loads an UNLOGGED,
   non-RLS per-job staging table (Postgres forbids COPY on RLS tables)" over the owner connection,
   isolation by access path — every read carries an explicit `workspace_id` predicate, all staging
   access confined to `importStagingRepository` (`importStagingRepository.ts:1–8`). §5 below
   re-audits 08/09/10 (written after 07) against this.
4. **`import_job_rows.input` is durable plaintext PII.** The per-row ledger stores "the raw parsed
   CSV row" as jsonb (`importJobs.ts:141`), workspace-RLS'd, retention class 365 d
   ([`../data-management/16-retention-engine-design.md`](../data-management/16-retention-engine-design.md)
   §3, seeded `shadow`). The reject histogram is non-PII by shipped discipline ("Never a row
   value", `importJobs.ts:68–69`); `reject_reason` is unconstrained `text` (`importJobs.ts:143`) —
   §3.3 pins its rule.
5. **Security skill ground truth (truepoint-security SKILL + references), including its honest
   implementation-status caveats:** everything outside the server is hostile; never log PII/tokens
   (a central logging-layer redactor is **unverified** — data-protection.md status note); PII is
   AES-GCM app-layer encrypted with HMAC blind indexes, **no KMS/envelope/rotation yet** (mandate
   stands as target); an SSRF guard exists for outbound webhooks
   (`packages/core/src/webhooks/ssrfGuard.ts`) but no confirmed enrichment-call allowlist; no
   WAF/edge absorption today (Caddy only). Designs below treat the mandates as the bar and the
   gaps as named work, never as license.
6. **Visibility/audit machinery is doc 10's:** creator-∪-elevated artifact gate, download audit
   (`import.artifact_downloaded` with actor + IP), 404-never-403 enumeration posture, the
   `JobViewer` signature guard (10 §2.1, §4, §7). This doc adds content controls on top, not a
   second permission model.
7. **Compliance machinery is shipped/designed elsewhere and cited, not re-frozen:** DSAR fan-out
   (`core/compliance/deleteFanout.ts` — hard-nulls contact PII, dependents, residual scan;
   data-management/16 §1), in-tx unbypassable suppression + the set-based bulk-import ingest
   screen ([`../data-management/05-compliance.md`](../data-management/05-compliance.md) §1 reuse
   map), Art.14 source-notice + DPDP modules (05-compliance §2–3), retention engine classes/modes
   (data-management/16). The shipped `packages/types/src/staffCapability.ts` governs Surface 1
   only; nothing here gates `apps/web` with a staff capability (two-surface rule).
8. **Locked decisions binding this doc:** DM1 (one crypto/normalizer set — `encryptPii`,
   `blindIndex` reused, never forked), DM4 (tenancy unchanged; no user GUC), DM6 (winner-map +
   pin), ADR-0006 (`source_imports` is the only lineage), ADR-0027 (outbox; payloads PII-free).

**Contradiction scan.** Two deliberate refinements of sibling docs, argued in place: (a) 08 §6.2
specifies "signed **expiring** download URLs" for artifacts; §4.3 below recommends
**proxied-with-audit** as the target (the FileStore is ours) and demotes signed URLs to a bounded
interim — a refinement 08 §6.2 already delegates ("full spec in 13"). 10 §5 row 5 and S-V5
inherit the same "signed expiring URL" wording from 08; the identical refinement applies to
them — the access gate, share-flag rule, and download audit are unchanged, only the delivery
mechanism is refined (§4.3). (b) The shipped bulk poll
returns `rejectedRowsUrl` to **any** workspace member (`bulkRoutes.ts:250–253`) — already flagged
by 10 §5 row 5 as closing when the artifact route ships; restated here because it is a G14 PII
exposure, not only a visibility one. No conflict found with DM1–DM9, ADR-0028, 15, or the shipped
capability enum.

---

## Current Challenges (headline only — the as-is is doc 01)

- Uploads are validated by extension sanitization + Zod form shape only (`bulkRoutes.ts:114–119`,
  `routes.ts` sibling); no content sniffing, no archive-bomb defence, and the AV seam returns
  `skipped` forever (01 §3.3, G08). The sync path parses unscanned files on the request thread
  today (01 §2.1 hop 4).
- One rejected-rows artifact exists, exposed by signed URL to the whole workspace, with no
  redaction pass, no typed codes, no retention class, no download audit (01 §2.2 hops 10–12; G14).
- PII posture is strong where 15 designed it (ciphertext staging, non-PII histogram, PII-free DLQ)
  and **unstated** everywhere newer: the ledger's `reject_reason`, artifact content, problem
  details, notification/event payloads, logs.
- Import data has retention classes but artifacts have none; DSAR fan-out does not yet name
  `import_job_rows.input` or artifacts as erasure targets.

## Enterprise Best Practices (cited via 03's register only)

- **Error artifacts are PII-bearing by design** — the repair CSV echoes the user's original
  columns (Salesforce `sf__Error` convention, 03 §6.1 [58]); HubSpot ships both the error report
  and the rows-with-errors file (03 §1.1 [5]) — hence "same encryption/AV/retention envelope as
  uploads" (03 §1.3).
- **Redaction is market practice:** HubSpot replaces sensitive values with `_REDACTED_` in error
  screens and files (03 §6.1 [5][18]).
- **Artifact access is the tightest gate, and downloads are audited:** original-file download is
  importer-or-super-admin; super-admins can see who downloaded a file, incl. IP and date
  (03 §5.1 [6][7]).
- **Limits are published product contracts and double as abuse controls:** per-file rows/bytes,
  per-day quota, concurrency — with early rejection (03 §6.1 [18][63][64]); the concurrency cap is
  visible as a state, not a silent queue (03 §6.1 [18]).
- **XLSX cannot be stream-read** (zip central directory at EOF, 03 §6.1 [144]) — the format is an
  archive, with an archive's attack surface.
- CSV formula-injection neutralization (prefixing `'` on `=`/`+`/`-`/`@` cells) is **not** in 03's
  register; it is recorded here as standard security practice (the OWASP CSV-injection
  convention) — a normative control of ours, not an external-platform behavior claim.

## Gaps (register pointers — evidence in 01, linkage in 02)

| Gap | Sev | This doc's answer |
|---|---|---|
| **G08** | P0 ❌gate | §2: the scanner port, wire points, infected terminal path, fail-closed outage policy, and the "gate cleared" definition |
| **G14** | P1 | §3–§4: the end-to-end PII discipline + the artifact protection envelope (encryption, access+audit, retention, formula-injection neutralization, redaction) |
| G01/G02 | P0/P1 | consumed from 10 (predicate, grants); §6 verifies every new endpoint against them |
| G07 | P0 ❌gate | consumed from 08 §8 Gate A (SSE-KMS at rest, presign, prod-adapter rule) — §4 relies on it |
| G12 | P2 | §7 reframes doc 12's published limits as the abuse-control layer |

---

## Recommended Solution

### §1 Upload security envelope 🔲

All rules apply to **both** processing modes and to the legacy one-shot path during 08 §1.2's
window; enforcement points are the upload route (pre-store) and the drive/validating phase
(pre-parse) — the client's declared type, size, and filename are never trusted (threat mindset).

1. **File-type validation by content, not extension.** The shipped extension sanitization
   (`bulkRoutes.ts:114–119`) stays as path hygiene only. Admission is by sniffing the first bytes
   of the stream: **XLSX** must present the ZIP local-file magic (`PK\x03\x04`) *and* contain a
   `[Content_Types].xml` entry naming the workbook part; **CSV** must match *no* known binary
   magic (ZIP, PDF `%PDF`, `MZ`, `\x7fELF`, common image/media magics) and must decode as text
   under the detected encoding. Declared `Content-Type` is recorded, never load-bearing.
   Mismatch ⇒ `415 unsupported_media_type` (08 §2.3's slug), no job row in the draft flow, `failed`
   with a PII-free reason if detected in the worker.
2. **Size caps, enforced before buffering.** The per-file byte ceiling and row ceiling are doc
   12's published numbers (08 §1 consumes them at routing); this doc's rule is *where*: reject on
   `Content-Length` when present, **and** count bytes on the multipart stream, aborting the read
   at ceiling+1 — a lying `Content-Length` never buffers past the cap. XLSX takes the lower
   ceiling 08 §1 already mandates (03 §6.1 [144]).
3. **Encoding handling is a security control, not only UX.** BOM/UTF-16 detection per 08
   §pre-build; undecodable bytes ⇒ `encoding_suspect` warnings (sparse) or a whole-file 422
   (systemic) — never silent mojibake, and never raw bytes echoed into error messages (§3.3).
   NUL bytes in a "CSV" ⇒ treated as binary ⇒ 415.
4. **Decompression hazards — XLSX IS a zip (zip bomb).** Enforced at central-directory read,
   before any extraction: (a) total **uncompressed** size cap (absolute number: doc 12; hard
   invariant: ≤ the published row/byte envelope's implied bound); (b) **expansion-ratio cap**
   (uncompressed/compressed ≤ 100×, config knob); (c) **entry-count cap** (≤ 1,000 entries);
   (d) per-entry uncompressed cap; (e) reject nested archives and any entry name containing `..`
   or an absolute path (path traversal via extraction); (f) parse only the workbook parts needed —
   never extract-all to disk. Violation ⇒ 422/`failed` with reason code `archive_limits_exceeded`,
   PII-free. Any archive/CSV-parsing dependency introduced for these caps (and any scanner client
   for §2) is vetted per the security skill's dependencies.md before adoption — lockfile-pinned,
   audited, maintained; the parser is itself attack surface (§2.2), so its supply chain is part of
   the control.
5. **Multipart hardening.** Caps on part count, per-field size, and header size; exactly one
   `file` part accepted (extras rejected, not ignored); non-file fields Zod-validated as today
   (`parseBulkImportForm`, `bulkRoutes.ts:78–102`); the filename is data, never a path — stored
   for display (`source_filename`, 08 S-I1), sanitized for the object key (shipped), and sanitized
   again on the download `Content-Disposition` (§1.6).
6. **Content-type pinning on every download response** (artifacts §4, any future original-file
   download): `Content-Type: text/csv; charset=utf-8` fixed server-side (never derived from stored
   metadata), `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` with a
   sanitized ASCII-fallback filename — a CSV must never be served renderable/sniffable in a
   browser context. Objects in the FileStore are never web-served paths (input-and-injection.md
   file-upload rules; the store is reached only through the API or short-lived presigns).

### §2 The AV/malware gate (G08 — the gate design) 🔲

#### §2.1 Vendor-agnostic scanner port

A `MalwareScannerPort` in `packages/core` (sibling of the `FileStore` port; core stays SDK-free,
adapters at the api/workers composition roots — the 08 §8 Gate A pattern):

```
scan(source: ReadableStream | { objectKey }) →
  { verdict: 'clean' | 'infected' | 'error', signature?: string, engine: string, scannedAt }
```

**Recommended baseline (not mandated): ClamAV** — a `clamd` sidecar spoken to over INSTREAM,
streaming from the FileStore, no new npm dependencies, self-hostable in the current single-region
deployment. A managed bucket-scanning service is an equally valid adapter behind the same port
when the object store (G07) lands on a cloud provider — the port is the contract; the vendor is
an ops choice (truepoint-operations owns the run cost/cadence). Scanner max-stream-size config
must be ≥ the doc 12 byte ceiling, or the ceiling lowers to match — a file too big to scan is a
file too big to accept.

#### §2.2 Wire points — scan-before-staging, verified against 08's state machine

Two invocations of the same port:

1. **Upload-time (the shipped seam, `bulkRoutes.ts:126–128` / the draft-flow equivalent):**
   scan synchronously when the scanner's latency budget allows (small files), else record
   `pending` and let the worker gate decide. `infected` here ⇒ refuse before any job exists
   (shipped refusal logic, `bulkRoutes.ts:169–171`) — no control row, no stored object retained.
2. **Drive/validating-time (mandatory, both modes):** the drive job re-checks
   `av_scan_status ∈ {clean}` before parse/staging begins, scanning now if still `pending` —
   this is the "promote-to-staging re-checks the gate" contract the seam comment promises and 08
   §8's Gate B restates ("re-checked before staging promote"). Nothing is parsed, staged, or
   merged from an unscanned or infected object. **Scan strictly precedes parse** — the parser is
   itself attack surface (§1.4), and the AV verdict must not depend on surviving it.

**Infected ⇒ terminal, no new job state.** Verified: 08 §2.1's machine has **no quarantine
state**, and none is added — `validating → failed` already carries "AV `infected`" as a legal
exit (08 §2.1). The specification is: job → `failed` (terminal), `av_scan_status='infected'`,
`failed_reason` = the stable code `av_infected` (never the filename, never scanner output
verbatim beyond the signature name); the **object** is quarantined, not the job — moved to a
`quarantine/` key prefix (or provider quarantine bucket) with all download paths refusing it, or
deleted outright where the adapter cannot move (config choice; quarantine-move is the default so
an operator can submit a false-positive for re-scan). **No artifact is ever generated for an
infected job**; the draft flow blocks preview/commit (409 `illegal_state`). In-tx effects on the
terminal transition (09 §6.2 discipline): audit event `import.av_infected` (actor = system,
jobId, signature name — no PII) + a `worker_outbox` operator-notification intent (the S2-class
alert; §9.2) + the creator's normal `import.notify` failure notification with neutral copy
("the file failed a security scan" — no signature detail to the tenant by default).

**Scanner outage = fail-closed.** `verdict:'error'`/timeout never admits a file: upload-time ⇒
record `pending` (job proceeds only as far as `queued`/`draft`); drive-time ⇒ the attempt fails
into the normal retry budget (09 §3) and, on exhaustion, the job terminalizes `failed` with
reason `av_unavailable` — delayed imports over unscanned imports, always (security precedence
rule). The outage is an §9.2 alert, not a bypass.

#### §2.3 What "gate cleared" means (the 08 §8 / doc 14 gate, made testable)

All of: (1) a real scanner adapter wired at both invocation points at the api **and** workers
composition roots; (2) the infected path integration-tested end-to-end with the EICAR test file
(refusal pre-job; `failed` + quarantine + audit + notification from the drive path) — T-S3;
(3) the fail-closed outage path tested (scanner down ⇒ no admission); (4) **no new production
upload ever records `av_scan_status='skipped'`** — the enum value survives for historical rows
only, and a monitor alerts on any new `skipped`/`pending`-older-than-SLA row (§9.2).
**Skipped-status backfill posture:** none required — bulk has never been enabled in production
(01 §2.2: dual-gated dark everywhere), so no production `skipped` rows exist to re-scan; if any
non-prod rows carry `skipped`, they stay as honest history. **Launch-blocker call (08 §8 left it
to this doc):** G08 is a **blocker for copy mode** (the gate rides Phase C) and a **fast-follow
for the fast path** — but §Rollout binds it: the fast path's Phase-B draft flow (files landing in
the shared FileStore) does not go GA without the scanner, because that is the moment stored
attacker files become long-lived shared-infrastructure objects. Sequencing lands in doc 14.

### §3 PII discipline end-to-end 🔲

One table of where import PII may exist, in what form, and the control that holds it there:

| Where | Form | Control (owner) |
|---|---|---|
| Upload object (FileStore) | raw plaintext file | encrypted at rest (SSE-KMS, 08 §8 Gate A); reachable only via API/worker; AV-gated (§2); draft objects reaped 48 h (08); source objects deleted on job purge (§4.4) |
| COPY staging — prepared columns | **ciphertext + blind index always** | the 15 §1 rule, restated verbatim — `prepareContact` encrypts before COPY; 05 §6 extends to channel payloads |
| COPY staging — `raw_data` | **the ONE documented transient-plaintext column** | 15 §8: REVOKE + DROP-on-finalize + the §2 AV gate; UNLOGGED; per-job table; never claimed otherwise |
| Overlay (`contacts`, `contact_emails`/`_phones`) | AES-GCM ciphertext + blind indexes | DM1 crypto; 05 §2.4 RLS; masked-until-reveal (`maskedContactSchema`, 05 §5) |
| `import_job_rows.input` | **durable plaintext jsonb** (Reconciliation #4) | RLS-walled; 365 d retention class; **never returned by any tenant API** (§3.2); DSAR-covered (§9.3); app-layer encryption recommended as hardening S-S6 (below) |
| Error artifacts | plaintext CSV **by design** (03 §1.3) | the §4 envelope |
| `reject_reason`, `reject_histogram`, problem details, `failed_reason` | **taxonomy codes + column refs only — never values** | §3.3 |
| DLQ records, outbox/event payloads, notifications | PII-free by contract | 09 §3/§4.4/§6 (restated §3.4) |
| Logs | none, ever | §3.5 |

#### §3.1 Child-table encryption + blind indexes (05, restated as controls)

Every channel value rides `encryptPii` (AES-256-GCM) + `blindIndex` (keyed HMAC), both keys
server-side with the KMS target on record (data-protection.md status note); blind indexes are
nulled **with** the ciphertext on DSAR/tombstone reap because a keyed HMAC of PII is still
personal data (05 §7 — adopted here as the compliance rule for *every* blind index this program
touches). Search/dedup never index plaintext (01 §6.11); masked payloads carry counts/types/
statuses, never values or secondary domains (05 §5).

#### §3.2 The ledger rule

`import_job_rows.input` exists for the repair artifact and support forensics. Controls: (a) no
tenant-facing endpoint returns `input` — the row drill-down 08 §7 paginates returns
`row_index + outcome + reject code + column ref` only; the values live in the repair CSV behind
§4's gate; (b) the staff drill-down reads it only under `data:review` on the audited platform
path (db-mgmt-research conventions; 01 §5.6); (c) retention 365 d (shipped class, seeded shadow —
data-management/16 §3) with the flip-to-enforce recorded in doc 14; (d) DSAR coverage per §9.3.
**Hardening (S-S6, recommended not gating):** move `input` to app-layer ciphertext
(`encryptPii` of the serialized row) once the artifact writer is the only reader — removes the
one durable plaintext PII column outside the sanctioned staging one.

#### §3.3 Never-logged, applied to import error paths — the taxonomy rule

**Rule: a reject/warning is always `code + column ref (+ row_index)`, never a cell value.**
Verified against 08: the §4 taxonomy is code-based and the histogram inherits the shipped
"never a row value" discipline (`importJobs.ts:68–69`) — compliant. Two spots need the rule
pinned because nothing structural enforces them yet, both in this doc's scope:

1. **`import_job_rows.reject_reason` (unconstrained `text`)** stores exactly `code` or
   `code:column_ref` — the writer helper is the enforcement point, plus T-S6's regex assertion.
2. **The repair CSV's `tp__error_detail` column** (08 §6.2) may need value context ("date
   '13/45/2024' unparseable") — legal **only inside the repair CSV**, which already contains the
   full row under §4's envelope; `tp__error_detail` must still never echo a *different* row's or
   column's value than the one it annotates. The **error report** (the aggregate) carries codes,
   columns, counts, sample line numbers — and any value fragment is replaced with `_REDACTED_`
   (03 §6.1 [5][18]), because the report's gate is the same but its blast radius (small, shareable
   file) invites forwarding.

RFC 9457 problem details, `failed_reason`, audit-event metadata, SSE/event payloads: codes and
ids only — the shipped posture (`bulkRoutes.ts` problems; 09 §4.4), now a stated invariant with
T-S6 as the tripwire.

#### §3.4 DLQ + outbox PII-free posture (09, restated as a control)

Dead-letter records carry scope + provenance + reason, never rows (`imports.ts:75–95`,
`bulkImports.ts:131–154`); outbox/event payloads are PII-free by contract (`eventOutbox.ts:6,32`;
09 §1.2 "Payload (PII-free, always)"). This doc adds only the audit obligation: T-S6 asserts the
DLQ record shape and event payloads against a PII-pattern scan, so the posture is regression-
tested, not remembered.

#### §3.5 Logs

Import paths never log request bodies, multipart fields, parsed rows, or filenames-as-typed
(the object key and `source_filename` column are the sanctioned homes). Because the central
logging-layer redactor is **unverified** (data-protection.md status), the import slices carry
their own discipline: structured log calls in `packages/core/src/import/`, `apps/api/src/
features/import/`, and the workers take `{jobId, workspaceId-as-id, code, counts}` shapes only —
enforced by review checklist + a grep-style lint (S-S6) that flags `logger.*(…row…|…input…|…file.name…)`
patterns in import modules. The redactor gap itself is repo-wide work recorded in doc 14, not
solved here.

### §4 Error artifacts — the G14 envelope 🔲

Both artifacts (repair CSV + error report, 08 §6.2) contain raw PII by design (03 §1.3). The
envelope, control by control:

#### §4.1 Encrypted at rest

Artifacts live in the same FileStore as uploads under the job's key prefix and inherit 08 §8
Gate A's SSE-KMS-at-rest requirement; the disk dev adapter remains dev/test-only (AC2). No
artifact is written before G07's adapter exists in prod — which is automatic, since artifacts
ship with S-I7 inside the same gated phases.

#### §4.2 Access + audit

Access = 10 §2.1's tightest gate: **creator ∪ elevated, `shared_with_workspace` ignored**, every
download an in-tx `import.artifact_downloaded` audit row (jobId, kind, actor, IP — 10 §7; the
HubSpot who-downloaded precedent, 03 §5.1 [7]). Denied/foreign ⇒ 404 (10 §4.2). Nothing here is
new — this doc binds artifact **content** to that gate and closes the shipped divergence: the
legacy poll's `rejectedRowsUrl` (any-member, `bulkRoutes.ts:250–253`) is retired with the legacy
surface (08 §1.2 window) and the new detail response mints descriptors only for callers passing
the gate (08 §7).

#### §4.3 Delivery: proxied-with-audit (recommended) over presigned

**Recommendation: proxied streaming download** — `GET /imports/:id/artifacts/:kind` authenticates,
evaluates the gate **at download time**, writes the audit row in the same request, sets §1.6's
pinned headers, and streams from the FileStore. Rationale: the FileStore is ours (G07 puts it
behind our composition root either way); a presigned URL is a bearer capability that outlives the
permission check that minted it, is copyable into chat/tickets, and its actual fetch bypasses the
API — audit-at-mint, not audit-at-access. Given artifact sizes (bounded by reject counts, not
file size) the proxy cost is negligible. **Presigned URLs remain the sanctioned fallback** for a
future large-artifact case, bounded: TTL ≤ 5 minutes, minted only inside the gate-passing detail/
artifact call, one mint = one audit row, never embedded in notifications or emails. This refines
08 §6.2's "signed expiring URLs" line — 08 delegated the spec here; doc 16 records the
resolution when S-I7 ships.

#### §4.4 Retention + deletion

- **New retention surface, aligned with data-management/16 §4** (which scoped raw-PII artifacts
  to "S3 lifecycle TTL, not DB retention"): artifacts get a **FileStore lifecycle TTL of 90 days**
  (repair loops are operational, measured in days; 03's platforms treat error files as
  short-lived downloads) plus a DB-side sweep that nulls `rejected_artifact_key`/artifact
  descriptors when objects lapse — the UI shows "expired" honestly instead of a broken link.
  The **source upload object** follows the job: deleted when its job row is purged (the
  `import_job_rows`/job-history retention horizon, doc 12/14 publish the job-row number), and at
  most 730 d to stay inside the `source_imports` archive horizon (16 §3). Draft objects: 48 h
  reap (08).
- **Artifact deletion on job purge:** the retention deleter for import jobs deletes the job's
  FileStore prefix (source + artifacts) before the row delete — object-store leftovers after a
  DB purge are orphaned PII, the exact failure data-protection.md's deletion rule names.
- Proposed class registration: `import_artifacts` (object-store class, 90 d, lifecycle-enforced)
  recorded in the retention engine's class table as documentation even though enforcement is
  lifecycle config, so the retention surface stays one inventory (16's posture).

#### §4.5 CSV formula-injection neutralization ON GENERATION

Both artifacts are CSVs users will open in Excel/Sheets. At write time, any cell whose first
character is `=`, `+`, `-`, `@` (or a tab/CR-led variant) is prefixed with `'` — the OWASP
CSV-injection convention (standard practice; see Enterprise Best Practices note). Applied by the
one artifact-writer module (S-S3) to **both** artifacts, including the echoed original columns of
the repair CSV — "echo byte-faithfully" (08 §6.2) is amended to "byte-faithful **except** the
leading-quote neutralization, documented in the artifact header row". A hostile cell
(`=WEBSERVICE(...)`, `=cmd|...`) uploaded in someone's CSV must not execute on the desk of the
admin who downloads the repair file — this is the repair-CSV half of the "infected file served
back" worst case (§11). T-S1 is the unit gate.

### §5 The sanctioned-bypass audit ✅ (verified, this doc)

The ONE bypass, restated from the design-of-record (15 §1/§8, quoted in Reconciliation #2–3):
per-job **UNLOGGED, non-RLS staging** on the owner copy connection, rows already prepared
(ciphertext), isolation by access path — explicit `workspace_id` predicate on every read,
confined to `importStagingRepository`, REVOKE + DROP on finalize, with the staging-predicate
isolation test mandatory (db-mgmt-research/05 §11; 08 T2 keeps it).

**Re-verified against the docs written after 07 §5's assertion:**

- **08:** fast mode uses **no staging at all** (08 §1 — "none — no COPY, no staging table");
  copy mode reuses the existing bypass unchanged ("the one RLS bypass, 07 §5"); every verb runs
  `withTenantTx` (08 §2.1, §pre-build). No new bypass.
- **09:** producers write outbox rows **inside `withTenantTx`** (09 §6.2); the relays
  (`outboxRelay`, `realtimeRelay`) read cross-tenant on the owner connection — that is the
  **pre-existing, shipped ADR-0027 pattern** (01 §7.1; `realtimeRelay.ts:5–6` per 09
  §pre-build), a system drain of PII-free intent tables, not a new overlay access path and not
  introduced by this series. No new bypass.
- **10:** explicitly "no policy DDL, no new GUC, no change to `withTenantTx`/`withErTx`/
  `withPlatformTx`; the one sanctioned staging bypass (07 §5) is unaffected" (10 §6.2). No new
  bypass.
- 04/05/06 were already cleared by 07 §1's second-bypass check (04's merge runs on
  `withTenantTx`, 05 stages ciphertext through the same table, 06 adds constraints not paths).

**Conclusion: the staging bypass remains the only RLS bypass in the target design.** Standing
rule for doc 16's checklist: any future design adding an owner-connection read/write of
tenant-owned data names this section and gets a security review before it is called sanctioned.

### §6 Tenant-isolation review — every new/changed endpoint from 08/10 🔲

Legend: **Authn** = `authn` middleware (verified token; workspace from token, never body —
shipped posture, `bulkRoutes.ts:6–8`). **Role** = workspace-role gate incl. 10 §3's
`who_can_import` policy. **Owner** = 10 §4's predicate/guard. **Tx** = `withTenantTx` (RLS).
**RL** = rate limit (bucket per 08 §2.3/10 §7). **Audit** = in-tx `audit_log` action.

| Route (08 §2.3 / 10 §5) | Authn | Role | Owner predicate | Tx | RL | Audit |
|---|---|---|---|---|---|---|
| `POST /imports` (upload/draft; legacy one-shot) | ✓ | member+ (G02; policy may raise to admin) | creator stamped (`created_by_user_id = claims.sub`) | ✓ | upload bucket + byte ceiling → 413 | — (draft); `import.committed` on one-shot |
| `PUT /imports/:id/mapping` | ✓ | member+ | creator ∪ elevated (draft is its creator's) | ✓ | std | — |
| `POST /imports/:id/preview` | ✓ | member+ | creator ∪ elevated | ✓ | **stricter CPU bucket** | — |
| `POST /imports/:id/commit` | ✓ | member+ / policy | creator ∪ elevated | ✓ | commit quota 20/h → 429 | `import.committed` |
| `POST /imports/:id/cancel` | ✓ | member+ | **creator ∪ elevated** (`assertCanCancel`) | ✓ | std | `import.cancelled` |
| `POST /imports/:id/retry-failed` | ✓ | member+ / policy (create-shaped) | creator ∪ elevated | ✓ | counts against commit quota | `import.retry_created` |
| `GET /imports` (list) | ✓ | viewer+ | **required `JobViewer`** — own+shared vs all (10 §2.1) | ✓ | std | — |
| `GET /imports/:id` (detail) | ✓ | viewer+ | same predicate as list (IDOR rule 10 §4.2) | ✓ | std | — |
| `GET /imports/:id/artifacts/:kind` | ✓ | member+ | **creator ∪ elevated only; share-flag ignored** | ✓ | **stricter download bucket** | **`import.artifact_downloaded`** (per download, §4.3) |
| `GET/PUT/DELETE /imports/mapping-templates…` | ✓ | read viewer+; manage member(own)/elevated(any) | template ownership + `visibility` (10 §5 row 10) | ✓ | std | `import.template_saved`/deleted |
| `GET/PUT import-policy` (settings) | ✓ | **admin/owner only** | n/a (workspace singleton) | ✓ | std | policy-change audit |
| Legacy `GET /imports/bulk/:jobId` (window) | ✓ | viewer+ | creator ∪ elevated (10 §5 row 2) | ✓ | std | — |

**IDOR posture.** Job ids are `uuid_generate_v7()` (`importJobs.ts:28`) — time-ordered, therefore
*partially predictable*; **id secrecy is never the control** (security skill: never trust a
client-supplied ID alone). The control is the predicate on every by-id read/verb (10 §4.2's
"detail applies the SAME predicate") + the tenant wall. Foreign/absent/invisible ⇒ **404
indistinguishable from absent, never 403** (shipped posture `bulkRoutes.ts:240–243`; 10 §7) — no
existence oracle. **Enumeration resistance:** opaque keyset cursors (house contract); uniform
404 shape/timing; the standard rate limiter throttles id sweeps; artifact kinds are a closed
enum (invalid kind = 404, not a probe result). Isolation tests: 08 T2 (cross-workspace), 10
T-V1/T-V3 (cross-user + IDOR probe) — this doc adds only T-S4's artifact-specific probe.

### §7 Abuse & rate limits 🔲

Product limits are doc 12's published numbers (G12); this table is the abuse mapping — every
scenario has a named control, and the raw 503 shed stays the never-in-normal-operation fuse
behind the product layer (09 §1.3).

| Abuse scenario | Control (owner) |
|---|---|
| Job-creation flood | per-workspace commit quota (20/h default) → 429 `import_quota_exceeded`; per-workspace concurrency cap → visible `deferred` (08 §2.3, 09 §1.3); create-grant G02 blocks viewer-tier automation (10 §3) |
| Artifact-download scraping (PII egress) | tightest access gate (§4.2) + **stricter per-user download bucket** + per-download audit rows → anomaly alert on volume (10 §7; §9.2); proxied delivery means no reusable bearer URLs (§4.3) |
| Mapping-template spam | member-tier writes only; per-workspace template cap (100, config knob) → 422; upsert-by-name bounds row growth (shipped unique, 08 §3.1); std rate limit |
| Zip-bomb / decompression | §1.4 caps (ratio/entries/uncompressed), enforced pre-extraction; T-S2 fixture |
| Oversized multipart / lying Content-Length | §1.2 stream-count abort at ceiling+1 → 413; multipart part/field caps (§1.5) |
| Repeated cancel/retry cycling | cancel idempotent (200 no-op) + std rate limit; retry-failed **counts against the commit quota** and replays the same child on the same key (08 §2.3/§6.3) — cycling burns the caller's own quota, spawns no fan-out |
| Preview CPU abuse (full-file projection) | stricter preview bucket (08 §2.3); projection cached on the draft row so re-renders don't re-scan (08 §4) |
| Hostile per-contact fan-out via channels | 25-per-contact channel caps at the edge (05 §pre-build); `channel_cap_exceeded` warning band |
| Draft hoarding (storage abuse) | 48 h draft reap + drafts bounded by the upload byte ceiling (08 §pre-build assumption 3) |
| Infected-file submission loops | AV refusal is pre-job (no row, no storage retained) and rate-limited like any upload; repeated `infected` verdicts per user surface in the §9.2 monitor |

### §8 SSRF forward-guard — constraints on 08 §9's extensions 🔲 (design constraints now, no code)

Scheduled imports, API-push, and CRM-pull (08 §9) will eventually take **URLs and credentials**.
These constraints bind those designs *now*, so the extension docs inherit them instead of
re-deriving (security skill: never trust outbound URLs; integrations.md rules adopted verbatim):

1. **No user-supplied URL is ever fetched from api or workers without an allowlist or an egress
   proxy.** CRM-pull goes to known provider domains (Salesforce/HubSpot API hosts) — allowlisted
   per integration, never a tenant-typed URL. A future "fetch from URL" import source is
   **deny-by-default**: `http(s)` only; reject private/loopback/link-local/metadata ranges
   (`10.x`, `172.16/12`, `192.168.x`, `127.x`, `169.254.x`, `::1`, and the cloud metadata
   endpoint) **re-checked after DNS resolution** (rebinding); redirects re-validated per hop;
   response size + timeout caps. The shipped webhook `ssrfGuard`
   (`packages/core/src/webhooks/ssrfGuard.ts`) is the reuse candidate — one guard, not a second
   implementation (DM1 ethos); its coverage gap on non-webhook paths is the named work.
2. **Credentials are server-side secrets from day one:** CRM OAuth tokens stored encrypted, never
   client-side, never logged, least-privilege scopes, `state` validated, revoked on disconnect
   (integrations.md); KMS is the standing target (data-protection.md status).
3. **Pulled data is untrusted input:** provider responses are schema-validated and land as
   ordinary `import_jobs` rows through the full envelope of this doc — same validation, same AV
   posture where files are fetched, same taxonomy, same artifacts rules. 08 §9 already pins "a
   pulled batch lands as an `import_jobs` row like everything else"; this section makes the
   security consequence explicit.
4. **Egress observability:** outbound fetches for imports carry per-destination metrics and a
   kill-switch flag per integration (rollback rule), so a compromised destination is
   turn-off-able without deploy.

These are acceptance criteria for any doc 14 phase that picks the extensions up; an extension
shipping without them is a review-rejectable finding.

### §9 Audit & incident 🔲

#### §9.1 The audit surface (consumed + bound together)

In-tx, never fire-and-forget (pre-build audit rule): lifecycle verbs (`import.committed`,
`.cancelled`, `.retry_created`, `.draft_reaped`, `.template_saved`, policy changes) — 08 §7;
every artifact download — 10 §7/§4.2 above; merges — 04 §3 (merge commit writes the audit event
with the loser's provenance map preserved); this doc adds `import.av_infected` (§2.2). Audit
rows carry ids/actions/codes, never record contents (data-protection.md audit rule; the shipped
append-only `audit_log`, 01 §6.10). Support must be able to reconstruct: who uploaded, what was
scanned, who committed, who cancelled, who downloaded which artifact when and from which IP —
from Postgres alone.

#### §9.2 Incident hooks (truepoint-operations)

| Trigger | Class | Response |
|---|---|---|
| Confirmed cross-tenant or cross-workspace read/write anywhere in the import path (incl. a staging predicate failure) | **breach-response, immediately** | truepoint-operations `breach-notification.md` — the GDPR 72 h clock starts at awareness; scope via audit + ledger; the RLS itests' job is to make this trigger theoretical |
| Artifact leak: download audit shows access by a non-creator/non-elevated principal, or an artifact URL/object reachable without the gate | breach-response (prospect PII) | revoke path (proxied: gate change is immediate; presigned: TTL ≤ 5 min bounds exposure); scope from `import.artifact_downloaded` rows; notify per breach process |
| New prod row with `av_scan_status='skipped'`, or `pending` older than SLA | S2 security alert | §2.3 monitor; investigate wiring regression — this is the G08 gate failing open |
| `infected` verdict on an upload | S3 routine (the control working) + operator notification (§2.2) | quarantine review runbook; repeated per-user hits → abuse review (§7) |
| Anomalous artifact-download volume (10 §7 monitor) | S2 | scraping playbook (abuse-and-edge.md posture): throttle, review audit trail, suspend principal |
| Scanner outage sustained | S2 ops | fail-closed holds (§2.2); runbook: restore scanner, drain retried drives |

Runbook homes: one line per feature per the operations skill — entries land in
`worker-platform/13-operational-runbooks.md` format alongside 09 §8's (stuck-queued, DLQ, relay
lag), with this doc adding the AV-outage, quarantine-review, and artifact-leak entries.

#### §9.3 DSAR — import data is in scope (requirement, not a redesign)

`import_job_rows.input` and both artifacts contain subject PII. The shipped DSAR fan-out
(`deleteFanout` — hard-null + dependents + residual scan, data-management/16 §1) **must extend
to them** (deletion is real — truepoint-data core principle):

- **Ledger:** locate subject rows via the blind-index lookup the DSAR machinery already uses
  (data-management/05-compliance §1 reuse map; 08-compliance §4) — match `input` rows by the
  subject's email blind index recomputed over the parsed row's email column(s) is *not* reliably
  possible on free jsonb; the workable v1 requirement is: null/overwrite the `input` jsonb of
  ledger rows whose `created/updated/matched_contact_id` or `source_import_id` pointers resolve
  to the erased subject's contact — pointer-driven, deterministic, and covered by the residual
  scan. (S-S6's ledger encryption makes the later re-scan surface smaller, not the obligation.)
- **Artifacts:** for jobs whose ledger contained subject rows, delete the job's artifact objects
  (regeneration-without-subject is not worth the machinery at v1 — blunt deletion is real); the
  90 d artifact TTL (§4.4) is the backstop that bounds the residual window either way, and that
  window is documented for counsel with the DSAR SLA.
- **Suppression already covers re-entry:** the ingest-time set-based suppression screen
  (05-compliance §1; 08-compliance §3.1) blocks the erased subject from being re-imported —
  restated here as the control that makes import-path erasure durable.

### §10 Compliance summary 🔲

#### §10.1 SOC 2 control mapping (the evidence an auditor asks for)

| Control | Where it lands in this program |
|---|---|
| Logical access | 10 §2.1 matrix + G02 grant + staff-cap wall (two-surface rule); evidenced by T-V suites + the compile-time `JobViewer` guard |
| Audit trail | §9.1's in-tx events incl. per-download rows with IP; append-only `audit_log` (trigger-enforced, 01 §6.10) |
| Data retention/disposal | retention classes (`import_job_rows` 365 d, artifacts 90 d lifecycle, source objects job-bound — §4.4) + retention_runs evidence rows (16 §2) |
| Change management | series rule: every slice CI-gated + security-reviewed (sandbox cannot run gates — standing flag); step IDs → doc 15 sequencing |
| Malware defence | §2's gate + T-S3 EICAR evidence + the no-new-`skipped` monitor |
| Encryption | app-layer AES-GCM + blind indexes today; KMS/envelope/rotation the recorded target (data-protection.md status) — stated honestly in any audit narrative |
| Incident response | §9.2 hooks → truepoint-operations severity/breach process |

#### §10.2 GDPR/DPDP data-minimization for imports — the honest tension + disposition

**What happens to unmapped columns today/target:** the *overlay* persists only mapped canonical
fields + registered custom fields (ADR-0028 typed registry — unmapped columns never reach
`contacts`). But the **full raw row — mapped and unmapped columns alike — persists** in
`source_imports.raw_data` (provenance, ADR-0006; 730 d class, archive-first intent) and
`import_job_rows.input` (365 d), and transiently in staging `raw_data` (dropped at finalize).

**The tension, stated:** provenance-keeping (ADR-0006's "only lineage"; the repair CSV's echo of
original columns, 03 §6.1 [58]; support forensics) directly pulls against storage-limitation/
minimization (collect only what the task needs — data-protection.md). Pretending either away
would be dishonest.

**Recommended disposition:** keep full-row provenance **as bounded liability**: (a) retention is
the minimization instrument — the 365/730 d classes flip to `enforce` on the doc 14 schedule
(today they shadow-count; that flip is a compliance deliverable, not a nice-to-have); (b) the
ledger/provenance rows are RLS-walled, never API-exposed (§3.2), DSAR-covered (§9.3), and
S-S6-encryptable; (c) a **per-workspace "drop unmapped columns" knob** is recorded as a doc 14
future enhancement for minimization-sensitive tenants (it trades away repair-CSV fidelity for
those columns — the wizard's explicit "Don't import column" already expresses per-column intent,
08 §3.2); (d) the DPA/RoPA documentation names raw-row provenance + its retention windows as a
processing record (compliance.md). **Art.14 note:** imported subjects are indirectly-obtained
personal data — every import feeds the record-level source-notice obligation designed in
data-management/05-compliance §2 (trigger sweep ≤ 1 month / first outreach); this series adds no
machinery, only the pointer that `source_imports` rows are its source-answer substrate.

**Residency note (skill obligation, stated once):** upload objects and artifacts are tenant PII
and sit wherever the FileStore bucket sits. Today the deployment is single-region (§11
assumption 1) so residency is trivially uniform; the standing rule for when residency
commitments land (data-protection.md) is that the G07 bucket **and** the §2 scanner placement
inherit the region pin together — a scanner streaming EU-resident files through another region
would breach the commitment the bucket keeps. No machinery in this series; the constraint is
recorded so G07's adapter choice carries it.

### §11 Explicit pre-build answers (delta — 08/09/10's passes cover the shared surface)

- **Worst case #1 — an infected file served back to a user.** Chain of controls: the original
  bytes are AV-gated at upload **and** before staging (§2.2); an infected job terminalizes with
  **no artifacts generated** (§2.2); the repair CSV is **regenerated content** (our writer
  serializes ledger/staging values — it never re-serves the original file's bytes), so binary
  payloads cannot ride it; cell-level payloads (formulas) are neutralized on generation (§4.5);
  downloads are pinned `text/csv` + `nosniff` + `attachment` (§1.6) so nothing executes in a
  browser; access is creator-∪-elevated + audited (§4.2). No single control is load-bearing
  alone — that is the point of the chain.
- **Worst case #2 — PII-in-logs regression.** Controls: the §3.3 taxonomy rule (codes+columns,
  never values) applied at every emission point; import-module log-shape lint + review gate
  (§3.5); T-S6's PII-pattern assertions over ledger/histogram/DLQ/problems/events as the CI
  tripwire; the unverified central redactor named as repo-wide follow-up (doc 14). Detection:
  T-S6 red or a log-scan hit; recovery: purge affected log streams + incident per §9.2.
- **Source of truth:** AV verdict = `import_jobs.av_scan_status` (the object's quarantine
  location derives from it); artifact existence = the job row's artifact keys; access policy =
  10's matrix; retention = the class table. No datum has two owners.
- **Failure modes:** scanner down ⇒ fail-closed hold (§2.2); artifact write fails ⇒ terminal
  status already committed, reaper re-sweeps the upload (09 §3 row 4); lifecycle TTL fires
  before a user downloads ⇒ honest "expired" state (§4.4); quarantine move fails ⇒ delete
  fallback (§2.2).
- **Rollback:** every step is additive/flag-gated (§Rollout); the scanner adapter can be
  disabled only by reverting to the *stub* — which the §2.3 monitor makes loud, deliberately:
  quietly turning off AV must be impossible.
- **Assumptions (written down):** (1) single-region deployment (08 §pre-build) — a second region
  re-opens the FileStore/scanner placement question, not the gate design; (2) artifact sizes
  stay ledger-bounded (rejects ≪ rows_total) — if a pathological all-rejected 2 M-row job makes
  proxying heavy, the §4.3 presigned fallback exists, bounded; (3) ClamAV signature currency is
  an ops responsibility (truepoint-operations) — a scanner with stale definitions passes the
  wiring tests but not the control's intent.

---

## Implementation Steps (step IDs — doc 15 sequences; statuses per series legend)

| Step | What ships | DDL | Depends on |
|---|---|---|---|
| **S-S1** | Upload envelope: magic-byte sniffing, stream byte-count abort, multipart caps, encoding rejection rules, download header pinning (§1.1–§1.3, §1.5–§1.6) | No | 08 S-I1 (draft flow optional — rules apply to legacy path too) |
| **S-S2** | **The G08 gate:** `MalwareScannerPort` + ClamAV adapter + both wire points + infected terminal path (audit + quarantine + notify) + fail-closed outage policy + the no-new-`skipped` monitor | No | G07 for the shared-store scan point; the upload-seam scan can precede it |
| **S-S3** | Formula-injection neutralizer in the single artifact-writer module (both artifacts) + `_REDACTED_` pass on the error report | No | 08 S-I7 (same slice) |
| **S-S4** | Proxied artifact download with in-request audit + pinned headers; presigned fallback bounded (TTL ≤ 5 min, audit-at-mint); legacy `rejectedRowsUrl` retirement rides 08's window | No | 10 S-V5, 08 S-I7 |
| **S-S5** | Zip-bomb/archive caps in the XLSX admission path (§1.4) + fixtures | No | S-S1 |
| **S-S6** | PII-discipline hardening: `reject_reason` writer rule + T-S6 assertions + import-module log lint; (recommended) `import_job_rows.input` app-layer encryption once the artifact writer is its only reader | No (encryption variant: No — same column, ciphertext content) | 08 S-I3/S-I7 |
| **S-S7** | Retention wiring: artifact lifecycle TTL (90 d) + key-nulling sweep + job-purge prefix deletion + `import_artifacts` class registration | No (config + sweep) | G07; data-management/16 engine |
| **S-S8** | DSAR extension: pointer-driven ledger `input` scrub + affected-job artifact deletion in `deleteFanout`; residual-scan coverage | No | S-S7; the shipped DSAR machinery |

The §8 SSRF constraints carry no step — they are acceptance criteria written into doc 14's
extension phases.

## UI/UX (pointer — doc 11 owns every surface)

Doc 11 consumes: the infected-file state ("failed a security scan" copy — neutral, no signature
detail), the expired-artifact state, download affordances that reflect the tightest gate
(non-creators simply don't see download actions — plus the honest disabled state for elevated
roles mid-generation), and the repair-CSV header note about the leading-quote neutralization.
Nothing renders here.

## DB & Backend (summary)

No new tables; no DDL beyond what 08/10 already carry. Code lands in existing homes:
`packages/core/src/import/` (sniffers, archive caps, artifact writer + neutralizer, scanner
port), `apps/api/src/features/import/` (scan seam replacement, proxied artifact route, download
headers), `apps/workers` (drive-phase scan check, retention sweep hooks),
`core/compliance/deleteFanout.ts` (S-S8), adapters at composition roots only (core stays
SDK-free — 08 §8 Gate A discipline).

## API (summary)

No new endpoints beyond 08 §2.3/10's set; this doc's deltas ride them: 415/413/422 problem slugs
(§1), `av_infected`/`av_unavailable` failure codes, the artifact route's response headers and
proxied semantics (§4.3), and the rule that no tenant response ever carries `input` row values
(§3.2). All RFC 9457, shared Zod, stable slugs.

## Edge Cases

CSV that is secretly a ZIP (415 by magic, §1.1) · XLSX renamed .csv (magic says ZIP without the
.xlsx admission path ⇒ 415, honest message) · zero-byte/-entry XLSX (422, §1.4 entry floor) ·
scanner returns `error` forever (fail-closed terminal `av_unavailable`, §2.2) · infected verdict
*after* upload-time `clean` (definitions updated between upload and drive — drive-time verdict
wins; job fails, object quarantined) · cancel racing the AV terminal (legality guard: first
terminal wins, 08 §2.1) · artifact downloaded at TTL boundary (proxied read checks object
existence; expired ⇒ 404 + honest UI state) · formula-looking legitimate data (`-42`, `+1-555…`)
— neutralization is display-safe and documented; repair-CSV re-import strips the leading quote
during parse (round-trip test T-S1) · DSAR against a job still `running` (fan-out defers to
terminal then scrubs — the residual scan catches stragglers) · presigned URL pasted into a
ticket (TTL ≤ 5 min bounds it; audit row exists from mint; §4.3 rationale).

## Testing (hooks — CI-run; this sandbox cannot execute gates; aligned with siblings, not duplicated)

- **T-S1 Formula-injection unit:** hostile cells (`=`, `+`, `-`, `@`, tab/CR-led) neutralized in
  both artifacts; legitimate negatives/phones round-trip through repair-CSV re-import.
- **T-S2 Zip-bomb fixture:** high-ratio, many-entry, nested-archive, and traversal-name XLSX
  fixtures all rejected pre-extraction with `archive_limits_exceeded`; memory stays bounded.
- **T-S3 Scanner itest (the G08 clearance test):** EICAR upload refused pre-job at the seam;
  EICAR via the drive path ⇒ `failed` + `av_scan_status='infected'` + quarantine + audit +
  notification, no artifacts; scanner-down ⇒ nothing admitted; clean file ⇒ `clean` recorded.
- **T-S4 Artifact-access IDOR probe:** extends 10 T-V3/T-V7 with the artifact route specifically
  — foreign-user artifact GET ⇒ 404, no audit "download" row (denials write nothing but the
  denial), no object touched; `shared_with_workspace=true` still denies non-creators (10 T-V5's
  artifact half).
- **T-S5 Redaction:** error report contains `_REDACTED_` where value fragments would appear;
  aligns 08 T8, adds the negative assertion (no raw cell value anywhere in the report).
- **T-S6 Never-PII sweep:** regex/pattern assertions that `reject_reason`, `reject_histogram`,
  problem details, `failed_reason`, DLQ records, and outbox/event payloads contain no email-like,
  phone-like, or fixture-seeded values — runs the same fixtures as 09 T-Q1/T-Q2 rather than new
  ones.
- **T-S7 Admission matrix:** magic-byte × extension × declared-type grid ⇒ correct 415/accept;
  lying Content-Length aborted at ceiling; download responses carry the pinned headers.
- **T-S8 DSAR coverage:** after fan-out for a seeded subject, ledger `input` scrubbed on
  pointer-matched rows, affected-job artifacts gone, residual scan clean; re-import of the
  subject blocked by the suppression screen.

## Rollout

S-S1/S-S5/S-S6/S-S7 are hardening — ship any time inside 08's Phase A dual-gate (flag-off =
byte-identical current behavior; they only tighten admission and hygiene on the new path).
S-S3/S-S4 ship with the artifact slice (S-I7/S-V5) — strict from birth, no legacy behavior to
preserve. **S-S2 is the G08 gate:** the scanner must be live before Phase B GA (files in the
shared store) and is a hard precondition of Phase C copy-mode enablement (08 §8; doc 14 places
it); the no-new-`skipped` monitor turns on with the adapter and never turns off. S-S8 rides the
retention/DSAR track independently. Rollback: flags off restore prior behavior everywhere except
S-S2, which is deliberately loud to disable (§11). Phase placement: doc 14; sequencing +
rehearsal: doc 15.

## Success Metrics

- **G08 closed:** T-S3 green in CI; 0 production uploads recording `skipped`/stale `pending`
  after the adapter ships; the monitor has fired 0 unexplained times.
- **G14 closed:** 100% of artifact downloads audited with actor+IP; 0 downloads outside
  creator-∪-elevated; 0 un-neutralized formula cells in generated artifacts (T-S1 in CI);
  artifacts expire on schedule (lifecycle metric) and 0 orphaned objects after job purges.
- **PII discipline holds:** T-S5/T-S6 green forever; 0 PII findings in log/DLQ/event audits;
  `reject_reason` values 100% taxonomy-shaped.
- **No second bypass:** §5's conclusion re-verified in doc 16 at every phase that touches the
  data path; the staging-predicate isolation test green in every run.
- **Incident readiness:** the §9.2 triggers each have a runbook entry landed; a tabletop of
  worst-case #1 walks the full control chain with no gap.
- **Compliance evidence:** retention classes for import data flipped per the doc 14 schedule;
  DSAR test T-S8 green; the minimization disposition (§10.2) recorded in the DPA/RoPA docs.
