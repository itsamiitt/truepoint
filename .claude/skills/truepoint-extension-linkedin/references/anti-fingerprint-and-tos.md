# Anti-fingerprint & Terms-of-Service posture

LinkedIn actively polices sales-intelligence extensions. This is not hypothetical: in April 2026 ("BrowserGate")
LinkedIn was found running hidden JavaScript that **fingerprints installed extensions by probing
`chrome-extension://<id>/<known-file>` across ~6,200 known extension IDs** — including Apollo, Lusha, and
ZoomInfo — and states it uses the signal to identify tools that "scrape member data … or break LinkedIn's
Terms of Service." Our posture is designed so that TruePoint is *not* one of those tools, technically and
in fact.

## Rules that keep us compliant and low-fingerprint

- **User-initiated, visible-only capture** (ADR-0043 §4). We read only what the signed-in user is looking at,
  on their action, with consent + source attribution. This is a materially different activity from
  bulk/background scraping, and the difference must stay real, not cosmetic.
- **No private-API interception.** No MAIN-world script, no `fetch`/`XHR` patching, no Voyager/Recruiter reads.
  This is both the ADR decision and the single behavior most likely to be flagged.
- **Keep `web_accessible_resources` absent.** A static WAR entry is exactly what the fingerprint probe reads.
  If a feature truly needs one, scope `matches` to `https://*.linkedin.com/*` **and** set `use_dynamic_url: true`
  so the resource URL isn't a stable, probeable path. (See `truepoint-extension-architecture/references/manifest.md`.)
- **Minimize host permissions and injected footprint.** Static hosts are `api.truepoint.in` + `*.linkedin.com`
  only; everything else is opt-in `optional_host_permissions`. Keep the injected surface to the Shadow-DOM
  hover card; prefer the Side Panel API (out-of-page) for real UI.
- **Server-side suppression + consent + audit.** Capture carries `consent`/`sourceUrl`/`capturedAt`; suppression
  and compliance run server-side. The extension is a producer, not a decision point.
- **Dark until legal sign-off** (ADR-0043 §9; README §3). Capture stays behind `CHROME_EXTENSION_ENABLED` +
  a per-tenant flag until compliance signs off.

## Not our job to defeat detection

We do not try to hide from or evade LinkedIn's fingerprinting — we make the extension genuinely compliant so
detection finds a compliant tool. `truepoint-security` has final say on any capture that could be read as
scraping; when in doubt, capture less and resolve more server-side.
