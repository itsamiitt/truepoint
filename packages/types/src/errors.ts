// errors.ts — RFC 9457 Problem Details and the typed error classes the whole platform throws (09 §6).
// A handler renders any AppError via toProblemDetails(); we never leak internals or PII in errors.

const ERROR_BASE = "https://leadwolf.dev/errors/";

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

  toProblemDetails(): ProblemDetails {
    return {
      type: `${ERROR_BASE}${this.code}`,
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

/** Cross-domain code exchange failed validation (reused/expired/wrong-IP/PKCE/origin) — ADR-0016. */
export class InvalidAuthCodeError extends AppError {
  constructor() {
    super({
      status: 400,
      code: "invalid_auth_code",
      title: "Authorization code is invalid or expired",
    });
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
