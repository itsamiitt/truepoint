// types.ts — view models for the Mailboxes & sending settings slice (M12, email-planning/13 P0). Mirrors the
// masked DTOs the API returns (@leadwolf/types email.ts) but with string timestamps (the JSON wire format —
// the server serializes Date → ISO). NO credential ever appears here (D7). Local types follow the
// per-feature convention (features/sequences/types.ts, features/inbox/types.ts).

export type MailboxProvider = "google" | "microsoft" | "smtp" | "ses";
export type MailboxStatus = "pending" | "connected" | "error" | "disconnected";
export type SendingDomainStatus = "pending" | "verifying" | "verified" | "failed";
export type DnsAuthState = "unverified" | "pass" | "fail";

export interface MailboxView {
  id: string;
  provider: MailboxProvider;
  address: string;
  sendingDomainId: string | null;
  status: MailboxStatus;
  lastError: string | null;
  connectedAt: string | null;
}

export interface SendingDomainView {
  id: string;
  domain: string;
  status: SendingDomainStatus;
  spfState: DnsAuthState;
  dkimState: DnsAuthState;
  dmarcState: DnsAuthState;
  trackingCname: string | null;
  trackingCnameState: DnsAuthState;
  region: string;
  verifiedAt: string | null;
}

export interface SendQuotaView {
  quota: number | null; // null = unlimited
  used: number;
  periodStart: string;
}

/** The connect-mailbox form payload (the credential is server-side-only — never read back). */
export interface ConnectMailboxInput {
  provider: MailboxProvider;
  address: string;
  sending_domain_id?: string;
  smtp_password?: string;
  oauth_token?: string;
}

/** A list that may not be wired yet — the {items, available} envelope (features/sequences convention). */
export interface MaybeList<T> {
  items: T[];
  available: boolean;
}
