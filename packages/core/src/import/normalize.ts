// normalize.ts — pure normalizers applied BEFORE hashing/encryption so dedup is stable (14 §5.2). Email
// gets two forms: a storage form (trim + lowercase, what we encrypt and derive the domain from) and an
// index form (storage form minus the local-part "+tag", so plus-aliases dedup to the same person). We do
// NOT strip dots — that is gmail-only and would merge distinct identities on other providers.

const collapseWs = (s: string): string => s.trim().replace(/\s+/g, " ");

/** Trimmed, non-empty text or undefined. */
export function normalizeText(raw: string | undefined | null): string | undefined {
  if (raw == null) return undefined;
  const v = collapseWs(raw);
  return v.length > 0 ? v : undefined;
}

/** Canonical email for storage + domain extraction: trim + lowercase. Undefined if empty. */
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
