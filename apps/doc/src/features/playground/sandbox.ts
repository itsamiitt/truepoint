// sandbox.ts — the playground's pure request simulator.
//
// The playground never touches the network: this module IS the "API" it calls, a deterministic function from
// a composed request to the response the real service would return. That is what keeps the page inside
// ADR-0048's zero-data posture (no data client, CSP connect-src 'self' untouched) and consistent with the
// authentication guide's own rule that keys belong on a backend, never in a browser — a live playground would
// be a page that teaches the opposite.
//
// Every behaviour here mirrors the published contract in src/content (endpoints/company.ts, endpoints/
// shared.ts) and the shipped service in apps/api/src/features/public-api: the 401-for-every-bad-key rule,
// 422 for an unparseable domain, a miss as 200 matched:false with nothing charged, the free match, the
// one-credit enrich, the idempotent replay, and the 402 hard stop. sandbox.test.ts asserts each one, so the
// simulator cannot drift from the reference without a test saying so.

export type SandboxEndpoint = "match" | "enrich";

export interface SandboxCompany {
  readonly domain: string;
  readonly name: string;
  readonly website_url: string;
  readonly description: string;
  readonly industry: string;
  readonly employee_count: number;
  readonly revenue_range: string;
  readonly ownership_type: string;
  readonly year_founded: number;
  readonly specialties: readonly string[];
  readonly hq_country: string;
  readonly hq_city: string;
  readonly last_updated: string;
}

export interface StoredReplay {
  readonly status: number;
  readonly body: unknown;
}

export interface SandboxRequest {
  readonly endpoint: SandboxEndpoint;
  readonly apiKey: string;
  readonly domain: string;
  readonly idempotencyKey: string;
  readonly balance: number;
  readonly replays: Readonly<Record<string, StoredReplay>>;
  readonly records: Readonly<Record<string, SandboxCompany>>;
}

export interface SandboxOutcome {
  readonly status: number;
  readonly body: unknown;
  readonly chargedCredits: 0 | 1;
  readonly replayed: boolean;
  /** Idempotency key to store this response under (successful enrich with a key), else null. */
  readonly storeKey: string | null;
  /** The one-sentence explanation of what just happened, shown beside the response. */
  readonly note: string;
}

const ERROR_TYPE_BASE = "https://truepoint.in/errors/";

/** Deterministic on purpose: the sandbox never pretends to be a traceable production request. */
const SANDBOX_REQUEST_ID = "req_sandbox";

/** Same normalisation the reference documents: full URLs, a www. prefix and mixed case are all accepted. */
export function normaliseDomain(raw: string): string | null {
  const trimmed = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!trimmed) return null;
  const host = (trimmed.replace(/^https?:\/\//, "").split("/")[0] ?? "").replace(/^www\./, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
}

/** The cURL a shipped integration would run for the composed request — shown live beside the form. */
export function buildCurl(request: {
  readonly endpoint: SandboxEndpoint;
  readonly apiKey: string;
  readonly domain: string;
  readonly idempotencyKey: string;
}): string {
  const key = request.apiKey.trim() || "$TRUEPOINT_API_KEY";
  const domain = request.domain.trim() || "northgate.example.com";
  if (request.endpoint === "match") {
    return [
      "curl -G https://api.truepoint.in/api/v1/public/company/match \\",
      `  -H "Authorization: Bearer ${key}" \\`,
      `  --data-urlencode "domain=${domain}"`,
    ].join("\n");
  }
  const idem = request.idempotencyKey.trim();
  return [
    "curl -X POST https://api.truepoint.in/api/v1/public/company/enrich \\",
    `  -H "Authorization: Bearer ${key}" \\`,
    '  -H "Content-Type: application/json" \\',
    ...(idem ? [`  -H "Idempotency-Key: ${idem}" \\`] : []),
    `  -d '{"domain":"${domain}"}'`,
  ].join("\n");
}

export function simulate(request: SandboxRequest): SandboxOutcome {
  const key = request.apiKey.trim();
  const domain = normaliseDomain(request.domain);
  const isEnrich = request.endpoint === "enrich";

  if (!key.startsWith("tp_live_")) {
    return {
      status: 401,
      body: {
        type: `${ERROR_TYPE_BASE}invalid_token`,
        title: "Token is invalid or expired",
        status: 401,
        code: "invalid_token",
        requestId: SANDBOX_REQUEST_ID,
      },
      chargedCredits: 0,
      replayed: false,
      storeKey: null,
      note: "Missing, malformed, unknown and revoked keys all answer the same 401 — the endpoint is not a credential oracle.",
    };
  }

  if (!domain) {
    return {
      status: 422,
      body: {
        type: `${ERROR_TYPE_BASE}validation_error`,
        title: "Invalid request",
        status: 422,
        code: "validation_error",
        detail: isEnrich
          ? "Body must be { domain: string }."
          : "A `domain` query parameter is required.",
      },
      chargedCredits: 0,
      replayed: false,
      storeKey: null,
      note: "Shape check only — a URL, a www. prefix or mixed case would have been normalised for you.",
    };
  }

  const idem = request.idempotencyKey.trim();
  if (isEnrich && idem) {
    const stored = request.replays[idem];
    if (stored) {
      return {
        status: stored.status,
        body: stored.body,
        chargedCredits: 0,
        replayed: true,
        storeKey: null,
        note: "Replayed: same Idempotency-Key, so the stored first response came back and nothing was charged.",
      };
    }
  }

  const record = request.records[domain];
  if (!record) {
    return {
      status: 200,
      body: { matched: false, company: null, credits_charged: 0 },
      chargedCredits: 0,
      replayed: false,
      storeKey: null,
      note: "A miss is a 200, not a 404 — and it is still counted, so your no-match rate stays visible to you.",
    };
  }

  if (!isEnrich) {
    return {
      status: 200,
      body: {
        matched: true,
        company: { domain, name: record.name },
        credits_charged: 0,
      },
      chargedCredits: 0,
      replayed: false,
      storeKey: null,
      note: "Match is free and rate-limited. Use it to decide whether enriching is worth a credit.",
    };
  }

  if (request.balance < 1) {
    return {
      status: 402,
      body: {
        type: `${ERROR_TYPE_BASE}insufficient_credits`,
        title: "Insufficient credits",
        status: 402,
        code: "insufficient_credits",
        balance: request.balance,
        required: 1,
      },
      chargedCredits: 0,
      replayed: false,
      storeKey: null,
      note: "A hard stop, not a retry. Top up, then replay with the same Idempotency-Key.",
    };
  }

  return {
    status: 200,
    body: {
      matched: true,
      company: { ...record, domain },
      credits_charged: 1,
      credits_remaining: request.balance - 1,
    },
    chargedCredits: 1,
    replayed: false,
    storeKey: idem || null,
    note: idem
      ? "Charged once. Send it again with this same key to see the replay."
      : "Charged once. Without an Idempotency-Key a retry after a timeout would charge again.",
  };
}
