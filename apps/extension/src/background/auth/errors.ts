// Auth error type shared across the auth modules (doc 12 §6). Distinguishes a transient auth-service
// problem (don't sign the user out — retry) from a hard failure (bad/expired credential).
export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason?: string,
  ) {
    super(code);
    this.name = "AuthError";
  }

  /** A transient auth-service problem (network/5xx) — keep any current token, don't sign out. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}
