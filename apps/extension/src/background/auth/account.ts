// account — the display identity (name/email/avatar/workspace) for the popup + profile. The access JWT
// carries NO name/email claim (doc 10 §1.3), so this is a separate Bearer read. Route is doc 10 §7's
// "GET /auth/me" exposed on the API for the extension (Bearer, no cookie): GET /api/v1/me. NET-NEW backend.
import { API_BASE } from "../../shared/env.ts";
import type { AccountDisplay } from "../../shared/messages.ts";

export async function fetchAccount(token: string): Promise<AccountDisplay | null> {
  try {
    const res = await fetch(`${API_BASE}/me`, {
      headers: { authorization: `Bearer ${token}` },
      // Bounded so a slow/hung /me never blocks anything (it's fetched off the token path anyway).
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as Partial<AccountDisplay>;
    return {
      name: data.name ?? null,
      email: data.email ?? null,
      avatarUrl: data.avatarUrl ?? null,
      workspaceName: data.workspaceName ?? null,
    };
  } catch {
    return null;
  }
}
