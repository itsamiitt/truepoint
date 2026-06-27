// providerAdapter.ts — the ESP/mailbox adapter seam for the M12 send path (email-planning/13 P1, 02, D1,
// 15 §B.2). A ProviderAdapter is just an EmailSenderPort (the M9 seam, unchanged): resolveSender(identity)
// returns the concrete sender for a mailbox's provider. The real network adapters (Amazon SES, Gmail API,
// Microsoft Graph, SMTP) register here in P1b — they need ESP credentials + a transport dependency and live
// outside the verifiable gate this phase ships. Until one is registered, resolveSender falls back to
// consoleSender (no network) so the flag-gated dark path never sends silently-wrong mail; a tenant is enabled
// for a REAL send (email.send) only once its domain is DNS-verified and a real adapter is wired (13 §4).

import type { MailboxProvider } from "@leadwolf/types";
import { type EmailSenderPort, consoleSender } from "../outreach/senderPort.ts";

/** The resolved per-tenant sending identity a send goes out on (D2/D3) — the input to an adapter factory. */
export interface SendIdentity {
  provider: MailboxProvider;
  /** The tenant's own from-address (a connected mailbox), never a shared TruePoint identity. */
  fromAddress: string;
  /** The tenant's DNS-verified sending domain (D2/D3). */
  sendingDomain: string;
  mailboxId: string;
  /** The owning scope — a credential-bearing adapter (Gmail/Graph) re-opens an RLS-scoped tx to load its
   *  per-mailbox token at send time (D7); carried here so the factory closure has it. */
  tenantId: string;
  workspaceId: string;
}

export type AdapterFactory = (identity: SendIdentity) => EmailSenderPort;

const registry = new Map<MailboxProvider, AdapterFactory>();

/** Register a concrete provider adapter (P1b: ses/google/microsoft/smtp). Idempotent per provider. */
export function registerAdapter(provider: MailboxProvider, factory: AdapterFactory): void {
  registry.set(provider, factory);
}

/** Clear the registry — test hygiene only. */
export function resetAdapters(): void {
  registry.clear();
}

/**
 * Resolve the sender for an identity. Returns the registered real adapter when one exists; otherwise the
 * dark-default consoleSender (no network). The send path is gated by the email.send flag + a DNS-verified
 * domain, so the fallback can never leak real mail — it is the safe dev/dark behaviour until P1b wires the
 * concrete adapters.
 */
export function resolveSender(identity: SendIdentity): EmailSenderPort {
  return registry.get(identity.provider)?.(identity) ?? consoleSender;
}
