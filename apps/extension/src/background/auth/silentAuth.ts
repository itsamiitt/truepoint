// silentAuth — the code → token exchange (doc 10 §1.3). REAL contract (apps/auth/src/app/token/exchange/
// route.ts): POST /auth/token/exchange, body {code, codeVerifier, state}, credentialed, → {accessToken,
// tokenType:"Bearer", expiresIn}. Distinct failures: 4xx = bad code (surface); 403 = origin not registered
// (a backend-config error, doc 10 §7); 503 = auth unavailable (retryable, don't sign out).
import { ENV } from "../../shared/env.ts";

export interface TokenResponse {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason?: string,
  ) {
    super(code);
    this.name = "AuthError";
  }

  /** A transient auth-service problem (don't sign the user out — retry). */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export async function exchangeCode(
  code: string,
  codeVerifier: string,
  state: string,
): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(`${ENV.authOrigin}/auth/token/exchange`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, codeVerifier, state }),
      // Bound the request so a hung exchange can never pin the single-flight silent re-auth.
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AuthError(0, "network_error");
  }
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; reason?: string };
    throw new AuthError(res.status, problem.code ?? "exchange_failed", problem.reason);
  }
  return (await res.json()) as TokenResponse;
}
