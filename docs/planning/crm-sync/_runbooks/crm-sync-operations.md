# Runbooks — CRM bidirectional sync

**crm-sync §9.6.** Four incident paths: signal → diagnosis → the control that already exists.

These are written against the code **as shipped**, not against the plan's assumptions. Where the plan
described a control that was not built, it says so rather than telling you to reach for a button that
does not exist — a runbook that lies during an incident is worse than no runbook.

---

## Before anything: what "off" already means

The engine is dark by **four independent gates**. Confirm which one is engaged before diagnosing further,
because three of the four look identical from the outside (nothing syncs) and the fixes are unrelated.

| Gate | Where | Symptom when engaged |
|---|---|---|
| L1 `CRM_SYNC_ENABLED` | env, workers + api | Sweep does not take its leader lock; runs close `cancelled` with `env_disabled` |
| L2 `crm_sync_enabled` | per-tenant flag | Runs close `cancelled` with `tenant_flag_off` |
| L3 `sync_mode` | `crm_connections` | Runs close `completed` in `shadow` — counted, nothing written |
| L4 `direction` | `crm_field_mappings` | Individual fields silently absent from a push/apply |

`GET /api/v1/admin/crm/sync-health` shows L3 per connection. L1/L2 are not on that surface — check the env
and the tenant flag directly.

**A run that closed `cancelled` is not a failure.** It means a gate refused. Alert fatigue was designed out
here deliberately, so a dark tenant produces no alerts at all.

---

## R1 — CRM provider outage

**Signal.** `crm.read_sync_health` shows many connections erroring at once, across tenants. Run rows close
`partial` or `failed` with `provider_5xx` / `transient`. The alert tick logs
`crm sync: connections need attention` with a high `connection_error` count.

**Diagnosis.** Cross-tenant and simultaneous ⇒ the provider, not us. A single tenant erroring is R2.

**Act.**

1. **Do nothing first.** Retries are exponential (5 attempts, 5s base) and the sweep re-drives on its own
   cadence. A short outage self-heals and the watermark does not move, so nothing is lost.
2. **If prolonged**, set `CRM_SYNC_ENABLED=false` and redeploy the workers. The sweep stops taking its lock;
   in-flight jobs finish or fail into the DLQ. This is the fleet-wide brake.
3. **On recovery**, set it back. The **reconcile tick** (24h, or trigger a manual pull) re-reads a 7-day
   window without trusting the watermark, so anything missed during the outage is picked up. This is the
   designed recovery path — you do not need to replay the DLQ to recover *data*.
4. **Then** triage the DLQ at `/crm-sync` in the admin console. Those rows are jobs that exhausted retries;
   the reconcile has probably already re-synced the underlying records, so most can be **Resolved**.

**What is NOT available.** There is no bulk DLQ replay button. `Mark retrying` records intent; it does not
re-enqueue. That is deliberate — see R4.

**No data loss.** The watermark only advances after a page applies cleanly, so an outage leaves it exactly
where it was.

---

## R2 — Revoked or expired token (one tenant)

**Signal.** One connection at `status='error'`; alert code `connection_error` or `token_expired`. Run rows
close `failed` with `auth_expired` / `auth_revoked`. DLQ rows carry `error_class='auth'`.

**Diagnosis.** `auth_expired` means the access token lapsed and the refresh did not run or failed.
`auth_revoked` (`invalid_grant`) means the customer or their admin revoked our app — that is **not**
recoverable by retrying, and repeated attempts can trip the provider's lockout.

**Act.**

1. **Never blind-retry an auth failure.** The runner already does not: `markError` records the failure
   without touching the credential, so a still-valid refresh token survives a transient blip.
2. `auth_expired` → check the **refresh tick** is running (`crm-sync-refresh-tick`, every 10 min). Reaching
   an expiry at all means the refresh path is also broken; that is why `token_expired` is *critical*.
3. `auth_revoked` → the customer must **reconnect**. Point them at Settings → CRM. `completeCrmConnect`
   updates the existing connection in place (same row, same links, same mappings), so a reconnect resumes
   rather than starting over. Their `sync_mode` is preserved — a reconnect never silently promotes or demotes.
4. Once connected, the reconcile backstop closes the gap. Resolve the auth DLQ rows.

---

## R3 — Rate lockout

**Signal.** Run rows with a rising `rate_limited_ct`; outcomes `rate_limited`; DLQ `error_class='rate_limited'`.
Or, if you configured a cap, pushes returning `budget_exhausted`.

**Diagnosis.** Distinguish two different things:

- **The provider throttled us** (`429` / `REQUEST_LIMIT_EXCEEDED`). The engine honours `Retry-After`
  automatically and does **not** count it as a failure. Usually self-correcting.
- **Our own budget refused the call** (`budget_exhausted`, reason `exceeded`). That is `CRM_BUDGET_CALLS_PER_HOUR`
  working. The hourly window rolls on its own.
- **Reason `unavailable`** is neither: Redis is unreachable and the guard **failed closed**. Fix Redis; the
  refusal is protecting the customer's quota from an unmetered sync, not a bug.

**Act.**

1. Confirm which of the three from the run row's `failed_reason`.
2. Provider throttle, persistent → reduce pressure: lower `CRM_SYNC_MAX_CONNECTIONS_PER_SWEEP`, or lower the
   per-lane `limiter` in `apps/workers/src/tuning.ts` (the CRM lanes each have an explicit jobs/second cap).
3. **To stop one tenant only**, turn off their `crm_sync_enabled` flag. Do not reach for `CRM_SYNC_ENABLED`
   for a single-tenant problem — it stops the fleet.
4. Budget exhaustion that recurs every hour means the cap is too low for that connection's real volume.
   Raise `CRM_BUDGET_CALLS_PER_HOUR`, or set it to `0` (unlimited) and rely on the provider's own limits.

---

## R4 — Bad field mapping

**Signal.** The hardest one, because **nothing fails**. Writes succeed, runs close `completed`, no alert
fires. What moves is the conflict count and customer complaints about wrong data in their CRM.

**Diagnosis.** A mapping with the wrong `direction` or `authority` writes the wrong side's value. It is
correct-looking at every layer — that is precisely why `conflict_backlog` is a first-class alert and why the
customer's sync page shows conflicts prominently.

**Act.**

1. **Stop the bleeding first.** Set the connection's `sync_mode` to `shadow` via
   `PATCH /api/v1/crm/connections/:id/sync-mode`. Shadow keeps running and keeps counting, so you can see
   what it *would* do while it writes nothing. This is better than `disabled` — you keep the diagnostic.
2. **Fix the mapping** in the customer's Settings → CRM editor, or via `PATCH /api/v1/crm/mappings/:id`.
   Only `direction`, `authority` and `enabled` are editable; if the mapping points at the wrong *field*,
   delete and recreate it (re-pointing would silently re-describe existing provenance).
3. **Verify in shadow.** Read the run rows — a shadow run reports the operation and content hash it *would*
   have written. Confirm the diff is what you expect before flipping back to `enforce`.
4. **Repair the damaged records.** Push is idempotent by content hash and upserts by the TruePoint uuid, so
   re-pushing corrected values converges without duplicating. Human-pinned fields were never clobbered —
   those went to the conflict queue instead, which is the safety net that makes this recoverable at all.

**What is NOT available.** There is no "replay a `sync_run_id` range" tool. The plan assumed one. Recovery is
via the reconcile backstop (re-reads 7 days) plus the idempotent push, which converges on correct values —
it is just not a single button.

---

## Reference — where to look

| Question | Where |
|---|---|
| Is this connection healthy? | `/crm-sync` in the admin console (cross-tenant, audited on every load) |
| What did this run actually do? | `crm_sync_runs` — counts + the `mode` snapshot that distinguishes shadow from enforce |
| What failed permanently? | `crm_sync_dead_letter`, PII-free, exhausted retries only |
| What needs a human decision? | `crm_sync_conflicts` — pinned fields the CRM tried to change |
| Where is each stream up to? | `crm_sync_state` — per (connection, object, direction) watermark |
| Who did what? | `audit_log` (`crm.*`) for tenant actions; `platform_audit_log` (`crm.*`) for staff |

**Every one of those is PII-free by construction.** The DLQ scrubs error detail, the conflict queue masks PII
values, the audit rows carry ids and provider only. If you find yourself needing the actual record content to
diagnose something, that is a signal the run ledger is missing a counter — not a reason to add customer data
to an ops surface.
