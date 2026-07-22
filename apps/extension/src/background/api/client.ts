// ApiClient — the ONLY component that talks to api.truepoint.in. Attaches the Bearer token, sets the
// Idempotency-Key on writes, and maps RFC 9457 problem+json onto the error taxonomy (02 §6/§11, 03 §1).
// Tenancy is taken from token claims (never sent by the caller as trusted input).
import type {
  ConsentContext,
  IngestionEnvelope,
  LinkedinResolveResponse,
  RawObservation,
} from "@leadwolf/types";
import { API_BASE } from "../../shared/env.ts";
import type { QueueItem } from "../../shared/idb.ts";
import type { ErrorClass, RevealCosts, RevealType, SubjectStatus } from "../../shared/types.ts";
import type { AuthModule } from "../auth/index.ts";

export class ApiError extends Error {
  constructor(
    readonly errorClass: ErrorClass,
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ProblemDetails {
  title?: string;
  detail?: string;
  code?: string;
}

function classify(status: number, code?: string): ErrorClass {
  if (code === "suppressed" || code === "suppression") {
    return "suppression";
  }
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 429) {
    return "rate_limit";
  }
  if (status === 400 || status === 422) {
    return "validation";
  }
  if (status >= 500) {
    return "transient";
  }
  return "unexpected";
}

export class ApiClient {
  constructor(private readonly auth: AuthModule) {}

  private async request<T>(
    path: string,
    init: RequestInit,
    opts: { idempotencyKey?: string } = {},
    retried = false,
  ): Promise<T> {
    const token = await this.auth.getAccessToken();
    if (!token) {
      throw new ApiError("auth", "not_authenticated", 401);
    }
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body) {
      headers.set("content-type", "application/json");
    }
    if (opts.idempotencyKey) {
      headers.set("idempotency-key", opts.idempotencyKey);
    }

    const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

    // 401 = a revoked/expired token (sid deny-list or expiry). Try ONE silent re-auth + retry (doc 10 §4.4).
    // The Idempotency-Key makes the retried write safe.
    if (res.status === 401 && !retried && (await this.auth.refreshNow())) {
      return this.request<T>(path, init, opts, true);
    }

    if (!res.ok) {
      const problem = (await res.json().catch(() => ({}))) as ProblemDetails;
      throw new ApiError(
        classify(res.status, problem.code),
        problem.title ?? res.statusText,
        res.status,
        problem.detail,
      );
    }
    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  /** Enqueue a captured observation on the unified ingestion contract (POST /ingest). */
  async ingest(item: QueueItem): Promise<SubjectStatus> {
    const tenantId = this.auth.tenantId;
    if (!tenantId) {
      throw new ApiError("auth", "not_authenticated", 401);
    }
    const { record } = item;
    const consent: ConsentContext = {
      basis: "legitimate_interest",
      sourceUrl: record.sourceUrl,
      capturedAt: record.capturedAt,
    };
    const observation: RawObservation = {
      ...record.fields,
      subjectKey: record.subjectKey,
      adapter: record.adapter,
      pageType: record.pageType,
    };
    const envelope: IngestionEnvelope = {
      source: "chrome_extension",
      scope: {
        tenantId,
        workspaceId: this.auth.workspaceId ?? undefined,
      },
      idempotencyKey: item.idempotencyKey,
      collectedAt: new Date().toISOString(),
      consent,
      records: [observation],
    };
    await this.request<{ accepted: number }>(
      "/ingest",
      { method: "POST", body: JSON.stringify(envelope) },
      { idempotencyKey: item.idempotencyKey },
    );
    return { contactId: null, known: true, owned: false, outcome: "saved" };
  }

  /** Metered reveal — requires an Idempotency-Key; charge + suppression are enforced server-side. The server
   *  returns the authoritative post-charge balance (`balanceAfter`) so the client updates the pill without a
   *  round-trip (billing.revealResponseSchema). */
  async reveal(
    contactId: string,
    revealType: RevealType,
    idempotencyKey: string,
  ): Promise<{ email?: string; phone?: string; creditsCharged?: number; balanceAfter?: number }> {
    return this.request(
      `/contacts/${encodeURIComponent(contactId)}/reveal`,
      { method: "POST", body: JSON.stringify({ reveal_type: revealType }) },
      { idempotencyKey },
    );
  }

  /** The tenant's credit balance — GET /credits/balance → { balance }. Tenant-scoped server-side; null on any
   *  failure (offline / signed-out / 401) so the pill degrades to "—" instead of crashing. */
  async credits(): Promise<number | null> {
    try {
      const data = await this.request<{ balance?: number }>("/credits/balance", { method: "GET" });
      return typeof data.balance === "number" ? data.balance : null;
    } catch {
      return null;
    }
  }

  /** Per-reveal_type credit cost (tenant-agnostic pricing) so the UI can show "Reveal email · N cr". */
  async revealCosts(): Promise<RevealCosts | null> {
    try {
      return await this.request<RevealCosts>("/credits/reveal-costs", { method: "GET" });
    } catch {
      return null;
    }
  }

  /** Resolve a LinkedIn public id (the `/in/<publicId>` slug) to this workspace's masked contact, if any —
   *  GET /contacts/by-linkedin/:publicId (chrome-extension/14 X01). Maps the masked resolution onto the non-PII
   *  SubjectStatus the content script + panel render; never returns email/phone plaintext. Throws ApiError on
   *  401/offline so the bus can degrade the LOOKUP to "unknown". */
  async resolveByLinkedin(publicId: string): Promise<SubjectStatus> {
    const resp = await this.request<LinkedinResolveResponse>(
      `/contacts/by-linkedin/${encodeURIComponent(publicId)}`,
      { method: "GET" },
    );
    return {
      contactId: resp.contactId,
      known: resp.known,
      owned: resp.owned,
      // A lookup is not a capture outcome; the known/owned booleans carry the real signal.
      outcome: "unknown",
      emailAvailable: resp.contact?.hasEmail ?? false,
      phoneAvailable: resp.contact?.hasPhone ?? false,
      // score (a buying-signal) is intentionally deferred until the signals feature is built.
      score: null,
    };
  }

  /** The caller's orgs (across tenants) for the org switcher — GET /orgs (chrome-extension/14 X04). Degrades to
   *  just the active org on any failure so the switcher never crashes. */
  async listOrgs(): Promise<{
    orgs: Array<{ tenantId: string; tenantName: string; isTenantOwner: boolean }>;
    activeTenantId: string | null;
  }> {
    try {
      return await this.request("/orgs", { method: "GET" });
    } catch {
      return { orgs: [], activeTenantId: this.auth.tenantId };
    }
  }
}
