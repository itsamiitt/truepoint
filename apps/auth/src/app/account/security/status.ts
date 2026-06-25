// status.ts — the small shared shape for the neutral per-section status banners. The server actions redirect
// back with a `?password=…` / `?mfa=…` / `?sessions=…` code (never a sensitive reason), and each section maps
// that code to a localizable message + a tone. Kept here so the three sections don't each redeclare the type.
export interface StatusMessage {
  tone: "ok" | "error";
  text: string;
}
