// AppShell - the customer app's chrome: the nav rail, the top bar with global search, the credits pill,
// the notifications bell and the org/workspace switchers, wrapped around a destination.
//
// Wrapped in Providers because the chrome itself reads server state (credits, notifications, the org list)
// through TanStack Query - useQueryClient() throws without it.
import { AppShell, HomePage, Providers, ToastProvider } from "@leadwolf/ui";

/** The app as a signed-in user sees it, with Home inside. */
export const App = () => (
  <Providers>
    <ToastProvider>
      <div style={{ height: 1000, overflow: "hidden", borderRadius: 8 }}>
        <AppShell>
          <HomePage />
        </AppShell>
      </div>
    </ToastProvider>
  </Providers>
);
