// AccountShell — the signed-in /account/security layout: wider than AuthShell because it is a settings
// surface rather than a single-purpose card, with an in-page section nav whose anchors the apps/web
// "Manage on the sign-in site" links deep-link into.
import { AccountShell, HistorySection, MfaSection, SessionsSection } from "@leadwolf/ui";
import { HISTORY, MFA_METHODS, SECTIONS, SESSIONS, ground } from "./_authFixtures";

/** The whole security surface: nav plus every section, as a user lands on it. */
export const SecuritySurface = () => (
  <div style={{ ...ground, height: 1560 }}>
    <AccountShell
      title="Security"
      subtitle="Manage how you sign in and where you are signed in."
      sections={SECTIONS}
    >
      <MfaSection
        methods={MFA_METHODS}
        hasPassword
        setPasswordHref="/reset"
        recoveryCodesRemaining={8}
      />
      <SessionsSection sessions={SESSIONS} />
      <HistorySection history={HISTORY} />
    </AccountShell>
  </div>
);

/** The same layout with no section nav — what it looks like before any section is registered. */
export const WithoutNav = () => (
  <div style={{ ...ground, height: 420 }}>
    <AccountShell title="Security" subtitle="Manage how you sign in." sections={[]}>
      <SessionsSection sessions={SESSIONS.slice(0, 1)} />
    </AccountShell>
  </div>
);
