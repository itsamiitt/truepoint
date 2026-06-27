// api.ts — the Mailboxes & sending settings slice's data access (M12, email-planning/13 P0). Typed,
// authenticated calls to /api/v1/email via fetchWithAuth + the in-memory access token (ADR-0016); the slice's
// only seam to the backend. List reads use the {items, available} envelope so a not-yet-enabled backend
// (404/501 behind the email.mailboxes flag) renders a calm EmptyState instead of an error (features/sequences
// convention). The connect form sends the credential ONCE; no response ever returns it (D7).

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  ConnectMailboxInput,
  MailboxView,
  MaybeList,
  SendQuotaView,
  SendingDomainView,
  StartMailboxConnectInput,
} from "./types";

const EMAIL_BASE = `${API_BASE}/api/v1/email`;

/** 404/501 = "not wired yet" (behind the flag) → available:false; any other !ok is a real error. */
function isUnavailable(status: number): boolean {
  return status === 404 || status === 501;
}

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

export async function fetchMailboxes(): Promise<MaybeList<MailboxView>> {
  const res = await fetchWithAuth(`${EMAIL_BASE}/mailboxes`);
  if (res.ok) {
    const data = (await res.json()) as { mailboxes: MailboxView[] };
    return { items: data.mailboxes ?? [], available: true };
  }
  if (isUnavailable(res.status)) return { items: [], available: false };
  throw new Error(await problemMessage(res, "Could not load mailboxes"));
}

export async function connectMailbox(input: ConnectMailboxInput): Promise<{ id: string }> {
  const res = await fetchWithAuth(`${EMAIL_BASE}/mailboxes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not connect the mailbox"));
  return (await res.json()) as { id: string };
}

/** Begin the OAuth connect — returns the provider consent URL the caller redirects the browser to. The token is
 *  minted on the consent screen and exchanged server-side at the callback; it never touches the client (D7). */
export async function startMailboxConnect(
  input: StartMailboxConnectInput,
): Promise<{ authorize_url: string }> {
  const res = await fetchWithAuth(`${EMAIL_BASE}/mailboxes/connect/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not start the mailbox connection"));
  return (await res.json()) as { authorize_url: string };
}

export async function fetchSendingDomains(): Promise<MaybeList<SendingDomainView>> {
  const res = await fetchWithAuth(`${EMAIL_BASE}/sending-domains`);
  if (res.ok) {
    const data = (await res.json()) as { domains: SendingDomainView[] };
    return { items: data.domains ?? [], available: true };
  }
  if (isUnavailable(res.status)) return { items: [], available: false };
  throw new Error(await problemMessage(res, "Could not load sending domains"));
}

export async function addSendingDomain(input: {
  domain: string;
  region?: string;
}): Promise<{ id: string }> {
  const res = await fetchWithAuth(`${EMAIL_BASE}/sending-domains`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not add the sending domain"));
  return (await res.json()) as { id: string };
}

/** Run SPF/DKIM/DMARC verification; the server promotes the domain to 'verified' only when all pass. */
export async function verifySendingDomain(id: string): Promise<SendingDomainView> {
  const res = await fetchWithAuth(`${EMAIL_BASE}/sending-domains/${id}/verify`, { method: "POST" });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not verify the domain"));
  return (await res.json()) as SendingDomainView;
}

export async function fetchSendQuota(): Promise<SendQuotaView | null> {
  const res = await fetchWithAuth(`${EMAIL_BASE}/send-quota`);
  if (res.ok) return (await res.json()) as SendQuotaView;
  if (isUnavailable(res.status)) return null;
  throw new Error(await problemMessage(res, "Could not load the send quota"));
}
