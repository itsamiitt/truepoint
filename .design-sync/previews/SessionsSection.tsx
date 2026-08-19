// SessionsSection — every session on the account, with revoke actions.
//
// The session backing THIS browser is marked `current` and is never offered for revoke: signing yourself
// out from your own settings page is not a security action, it is a footgun. That distinction is the whole
// point of the component, so every cell keeps a current session in the list.
import { AccountShell, SessionsSection } from "@leadwolf/ui";
import { SESSIONS, ground } from "./_authFixtures";

const Frame = ({ children, height = 560 }: { children: React.ReactNode; height?: number }) => (
  <div style={{ ...ground, height }}>
    <AccountShell title="Security" sections={[]}>
      {children}
    </AccountShell>
  </div>
);

/** Three devices signed in — the current one plus two revocable others. */
export const MultipleDevices = () => (
  <Frame>
    <SessionsSection sessions={SESSIONS} />
  </Frame>
);

/** Only this browser: nothing to revoke, so the bulk action has nothing to act on. */
export const OnlyCurrent = () => (
  <Frame height={420}>
    <SessionsSection sessions={SESSIONS.slice(0, 1)} />
  </Frame>
);
