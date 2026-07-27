// pkce.ts — PKCE S256 helpers (browser Web Crypto). The verifier stays in sessionStorage between the
// redirect to the auth origin and the callback; only the S256 challenge ever leaves the browser (ADR-0016).
function base64url(bytes: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(digest) };
}

export function randomState(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)).buffer);
}
