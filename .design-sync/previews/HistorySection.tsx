// HistorySection — recent sign-in activity, read-only. Shares the session view with SessionsSection but
// offers no actions: this is the record, not the control surface.
import { AccountShell, HistorySection } from "@leadwolf/ui";
import { HISTORY, ground } from "./_authFixtures";

const Frame = ({ children, height = 560 }: { children: React.ReactNode; height?: number }) => (
  <div style={{ ...ground, height }}>
    <AccountShell title="Security" sections={[]}>
      {children}
    </AccountShell>
  </div>
);

/** Four sign-ins across four devices. */
export const RecentActivity = () => (
  <Frame>
    <HistorySection history={HISTORY} />
  </Frame>
);

/** A brand-new account: one sign-in, the one happening now. */
export const FirstSignIn = () => (
  <Frame height={400}>
    <HistorySection history={HISTORY.slice(0, 1)} />
  </Frame>
);
