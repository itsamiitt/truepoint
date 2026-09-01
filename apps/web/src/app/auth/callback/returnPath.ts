// returnPath.ts — PURE validation of the pre-login return stash. sessionStorage is same-origin-writable,
// so the stashed value is treated as untrusted: it is honored only as a same-origin PATH. Anything that
// could leave the origin — a protocol-relative "//host", a full URL, a backslash (browsers normalize "\"
// to "/" in URLs, so "/\evil.com" becomes "//evil.com") — is rejected and the fixed post-login
// destination is used instead. Never a redirect target beyond this origin, by construction.
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//")) return null;
  if (raw.includes("\\")) return null;
  return raw;
}
