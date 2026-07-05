// ApiClient — the ONLY component that talks to api.truepoint.in. Attaches the Bearer token, sets the
// Idempotency-Key on writes, and maps RFC 9457 problem+json onto the error taxonomy (02 §6/§11, 03 §1).
// Tenancy is taken from token claims (never sent by the caller as trusted input).
import type { ConsentContext, IngestionEnvelope, RawObservation } from "@leadwolf/types";
import { API_BASE } from "../../shared/env.ts";
import type { QueueItem } from "../../shared/idb.ts";
import type { ErrorClass, RevealType, SubjectStatus } from "../../shared/types.ts";
import type { AuthModule } from "../auth/module.ts";

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

  /** Metered reveal — requires an Idempotency-Key; charge + suppression are enforced server-side. */
  async reveal(
    contactId: string,
    revealType: RevealType,
    idempotencyKey: string,
  ): Promise<{ email?: string; phone?: string }> {
    return this.request<{ email?: string; phone?: string }>(
      `/contacts/${encodeURIComponent(contactId)}/reveal`,
      { method: "POST", body: JSON.stringify({ reveal_type: revealType }) },
      { idempotencyKey },
    );
  }

  async credits(): Promise<number | null> {
    try {
      const data = await this.request<{ balance?: number }>("/credits/me", { method: "GET" });
      return typeof data.balance === "number" ? data.balance : null;
    } catch {
      return null;
    }
  }
}
