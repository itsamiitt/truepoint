// normalize.ts — the CANONICAL pre-hash normalizers for the whole monorepo (@leadwolf/identity; doc 16
// duplication kill-list #1). Relocated verbatim from packages/core/src/import/normalize.ts so the master
// graph's persisted blind indexes (master_emails.email_blind_index) stay the source of truth: email has a
// storage form (trim + lowercase) and an index form (storage form minus the local-part "+tag"). Dots are NOT
// stripped — that is gmail-only and would merge distinct identities on other providers.

const collapseWs = (s: string): string => s.trim().replace(/\s+/g, " ");

/** Trimmed, whitespace-collapsed, non-empty text — or undefined. */
export function normalizeText(raw: string | undefined | null): string | undefined {
  if (raw == null) return undefined;
  const v = collapseWs(raw);
  return v.length > 0 ? v : undefined;
}

/** Canonical email for storage + domain extraction: trim + lowercase. Undefined if empty or not an address. */
export function normalizeEmailForStorage(raw: string | undefined | null): string | undefined {
  const v = normalizeText(raw)?.toLowerCase();
  return v?.includes("@") ? v : undefined;
}

/** Email form used for the blind index: storage form with the local-part "+tag" removed. */
export function normalizeEmailForIndex(storageEmail: string): string {
  const at = storageEmail.lastIndexOf("@");
  if (at <= 0) return storageEmail;
  const local = storageEmail.slice(0, at);
  const domain = storageEmail.slice(at + 1);
  const plus = local.indexOf("+");
  const cleanLocal = plus >= 0 ? local.slice(0, plus) : local;
  return `${cleanLocal}@${domain}`;
}

/** Domain part of a storage-form email (a non-PII facet). */
export function emailDomainOf(storageEmail: string): string | undefined {
  const at = storageEmail.lastIndexOf("@");
  return at > 0 ? storageEmail.slice(at + 1) : undefined;
}

/** Normalize a company/website domain: lowercase, strip scheme/path and a leading www. */
export function normalizeDomain(raw: string | undefined | null): string | undefined {
  const v = normalizeText(raw)?.toLowerCase();
  if (!v) return undefined;
  const noScheme = v.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const host = noScheme.split("/")[0];
  return host?.includes(".") ? host : undefined;
}

/** Extract the LinkedIn public id (slug) from a profile URL, or pass through a bare slug. */
export function linkedinPublicIdOf(raw: string | undefined | null): string | undefined {
  const v = normalizeText(raw);
  if (!v) return undefined;
  const m = v.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return (m?.[1] ?? v).toLowerCase();
}
