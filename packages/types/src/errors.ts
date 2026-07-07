// errors.ts — RFC 9457 Problem Details and the typed error classes the whole platform throws (09 §6).
// A handler renders any AppError via toProblemDetails(); we never leak internals or PII in errors.
// This is a browser-imported leaf package, so it must NOT read process.env / import @leadwolf/config. The
// `type` namespace is injected by the server-side renderer (apps/api) via toProblemDetails(typeBase); the
// fallback below is a brand-free relative URI (RFC 9457 permits relative `type` values).

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  [ext: string]: unknown;
}

/** Base for every expected, mapped error. `code` is the stable machine-readable identifier. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly extensions: Record<string, unknown>;

  constructor(args: {
    status: number;
    code: string;
    title: string;
    detail?: string;
    extensions?: Record<string, unknown>;
  }) {
    super(args.detail ?? args.title);
    this.name = new.target.name;
    this.status = args.status;
    this.code = args.code;
    this.title = args.title;
    this.extensions = args.extensions ?? {};
  }

  toProblemDetails(typeBase = "/errors/"): ProblemDetails {
    return {
      type: `${typeBase}${this.code}`,
      title: this.title,
      status: this.status,
      code: this.code,
      ...(this.message && this.message !== this.title ? { detail: this.message } : {}),
      ...this.extensions,
    };
  }
}

export class ValidationError extends AppError {
  constructor(detail?: string, extensions?: Record<string, unknown>) {
    super({ status: 422, code: "validation_error", title: "Invalid request", detail, extensions });
  }
}

/**
 * Generic authentication failure. Deliberately uniform: the same error covers bad password, unknown
 * account, locked account, and expired challenge — auth never reveals which step failed (17 §2/§6).
 */
export class InvalidCredentialsError extends AppError {
  constructor() {
    super({ status: 401, code: "invalid_credentials", title: "Check your credentials" });
  }
}

export class MfaRequiredError extends AppError {
  constructor(methods: readonly string[]) {
    super({
      status: 401,
      code: "mfa_required",
      title: "Additional verification required",
      extensions: { methods },
    });
  }
}

/**
 * Which client-side check the cross-domain code exchange failed on (ADR-0016). Diagnostic only — it names
 * the failing check, never the offending value (no code/verifier/IP), so it is safe to surface to the
 * caller. Distinct from {@link AuthInfraError}, which is a SERVER fault, not a bad client code.
 */
export type AuthCodeFailureReason =
  | "code_not_found" // not in the store: expired (>TTL), already used, or never issued
  | "ip_mismatch" // the exchange came from a different client than the login
  | "origin_mismatch" // the request origin isn't the allow-listed origin the code was bound to
  | "pkce_mismatch"; // the PKCE verifier doesn't match the challenge bound at login

/** Cross-domain code exchange failed validation (reused/expired/wrong-IP/PKCE/origin) — ADR-0016. */
export class InvalidAuthCodeError extends AppError {
  constructor(reason?: AuthCodeFailureReason) {
    super({
      status: 400,
      code: "invalid_auth_code",
      title: "Authorization code is invalid or expired",
      ...(reason ? { extensions: { reason } } : {}),
    });
  }
}

/**
 * An auth dependency failed (the code store is unreachable, or token signing failed) — a SERVER fault, not
 * a bad client code. We answer with a generic `auth_unavailable` so we never leak infra detail or invite a
 * client to "retry with a better code"; the specific {@link reason} is for SERVER LOGS only (ADR-0016).
 */
export type AuthInfraReason = "redis_unavailable" | "token_mint_failed";
export class AuthInfraError extends AppError {
  readonly reason: AuthInfraReason;
  constructor(reason: AuthInfraReason) {
    super({
      status: 503,
      code: "auth_unavailable",
      title: "Authentication is temporarily unavailable",
    });
    this.reason = reason;
  }
}

export class InvalidTokenError extends AppError {
  constructor() {
    super({ status: 401, code: "invalid_token", title: "Token is invalid or expired" });
  }
}

export class ForbiddenError extends AppError {
  constructor(code = "forbidden", detail?: string) {
    super({ status: 403, code, title: "Not allowed", detail });
  }
}

export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds: number) {
    super({
      status: 429,
      code: "rate_limited",
      title: "Too many attempts",
      extensions: { retryAfterSeconds },
    });
  }
}

export class NotFoundError extends AppError {
  constructor(detail?: string) {
    super({ status: 404, code: "not_found", title: "Not found", detail });
  }
}

/**
 * A registration conflict — the chosen email or username is already taken (ADR-0020). Registration
 * deliberately reveals existence (unlike the uniform credential error), so the `code` is specific
 * (`email_taken` | `username_taken`) and the UI maps it to a precise field-level message.
 */
export class ConflictError extends AppError {
  constructor(code: "email_taken" | "username_taken", detail?: string) {
    super({ status: 409, code, title: "Already in use", detail });
  }
}

/**
 * Contact TRUE-MERGE legality — a merge input is already merged/tombstoned (import-and-data-model-redesign
 * 04 §API/§pre-build edge): loser already merged, or survivor tombstoned. 409 `contact_merged` carrying a
 * `mergedInto` extension member so a stale reference resolves to the survivor (the same code a 410-style
 * detail read of a merged id returns). Merge is irreversible — this is a hard stop, never a retry.
 */
export class ContactMergedError extends AppError {
  constructor(mergedInto: string | null, detail?: string) {
    super({
      status: 409,
      code: "contact_merged",
      title: "Contact already merged",
      detail,
      ...(mergedInto ? { extensions: { mergedInto } } : {}),
    });
  }
}

/**
 * Contact TRUE-MERGE per-workspace daily cap reached (04 §3.1 — the FinOps-style brake against a runaway or
 * abusive merge loop of an irreversible, destructive verb). 409 `merge_daily_cap`; the cap resets at UTC
 * midnight. A guardrail, not an error the client should auto-retry.
 */
export class ContactMergeCapError extends AppError {
  constructor(detail?: string) {
    super({ status: 409, code: "merge_daily_cap", title: "Daily merge limit reached", detail });
  }
}

/**
 * A verb was requested against a resource in a state that does not permit it — the 08 §2.1 state-machine
 * legality violation (e.g. cancelling a terminal or non-cancellable import). 409 with the stable
 * `illegal_state` slug (the import-redesign series harmonizes on 409, not 422 — 08 §2.1); `currentState` is
 * a non-PII enum, safe to surface so the client can render the reason.
 */
export class IllegalStateError extends AppError {
  constructor(detail?: string, currentState?: string) {
    super({
      status: 409,
      code: "illegal_state",
      title: "Action not allowed in the current state",
      detail,
      ...(currentState ? { extensions: { currentState } } : {}),
    });
  }
}

/** An import row (or its column mapping) failed validation — carries the offending row index(es). */
export class ImportValidationError extends AppError {
  constructor(detail?: string, extensions?: Record<string, unknown>) {
    super({
      status: 422,
      code: "import_validation_error",
      title: "Import is invalid",
      detail,
      extensions,
    });
  }
}

/**
 * The malware scanner is CONFIGURED but unreachable/failing (import-redesign 13 §2.2, S-S2/G08) — the
 * FAIL-CLOSED refusal at upload admission: a real scanner that cannot answer never admits a file (delayed
 * imports over unscanned imports, always). 503 with the stable `scan_unavailable` slug and honest copy;
 * carries NOTHING about the engine or the file. Distinct from an `infected` refusal (a 422 at the seam).
 */
export class ScanUnavailableError extends AppError {
  constructor(detail?: string) {
    super({
      status: 503,
      code: "scan_unavailable",
      title: "Upload scanning is temporarily unavailable",
      detail,
    });
  }
}

/**
 * The per-workspace import commit quota is exhausted (import-and-data-model-redesign 08 §2.3 / 12 §5, S-I10):
 * commits (incl. retry-failed children — a retry "counts against the commit quota") per workspace per hour
 * exceed `IMPORT_MAX_COMMITS_PER_HOUR`. 429 with the stable `import_quota_exceeded` slug; `retryAfterSeconds`
 * (when known) lets the client back off. Non-PII.
 */
export class ImportQuotaExceededError extends AppError {
  constructor(detail?: string, retryAfterSeconds?: number) {
    super({
      status: 429,
      code: "import_quota_exceeded",
      title: "Import quota reached",
      detail,
      ...(retryAfterSeconds ? { extensions: { retryAfterSeconds } } : {}),
    });
  }
}

/** The tenant credit balance can't cover the reveal — 402 with balance + required so the UI can prompt (09 §6). */
export class InsufficientCreditsError extends AppError {
  constructor(balance: number, required: number) {
    super({
      status: 402,
      code: "insufficient_credits",
      title: "Insufficient credits",
      detail: `This reveal costs ${required} credit${required === 1 ? "" : "s"}; balance is ${balance}.`,
      extensions: { balance, required },
    });
  }
}

/**
 * A sensitive staff action needs a just-in-time elevation that the caller does not currently hold (13a F1,
 * 13 §2). 403 with the required action class in extensions so the console can mint the elevation (reason) and
 * retry. Distinct from the role gate (ForbiddenError): the caller may have the role yet still lack a live,
 * time-boxed, tenant-scoped elevation for this action.
 */
export class ElevationRequiredError extends AppError {
  constructor(action: string, detail?: string) {
    super({
      status: 403,
      code: "elevation_required",
      title: "Elevation required",
      detail: detail ?? `This action requires a just-in-time elevation for '${action}'.`,
      extensions: { action },
    });
  }
}

/** The contact is on a suppression/DNC list — reveals and sends are blocked, regardless of credits (08 §3). */
export class SuppressedError extends AppError {
  constructor(reason?: string) {
    super({ status: 403, code: "suppressed", title: "Contact is suppressed", detail: reason });
  }
}

/** The enrichment daily cost budget is exhausted — calls pause until the window resets (06 §6). */
export class ProviderBudgetExceededError extends AppError {
  constructor(detail?: string) {
    super({
      status: 429,
      code: "enrichment_budget_exhausted",
      title: "Enrichment budget exhausted",
      detail,
    });
  }
}

/** The tenant's daily AI NL-search budget is exhausted — calls pause until the UTC-day window resets (23 §7). */
export class AiBudgetExhaustedError extends AppError {
  constructor(detail?: string) {
    super({ status: 429, code: "ai_budget_exhausted", title: "AI search budget reached", detail });
  }
}

/** The AI provider is unreachable or could not return a valid filter — never leaks the model/prompt (23, ADR-0023). */
export class AiUnavailableError extends AppError {
  constructor(detail?: string) {
    super({ status: 502, code: "ai_unavailable", title: "AI search is unavailable", detail });
  }
}
