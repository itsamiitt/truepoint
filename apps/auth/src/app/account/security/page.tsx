// page.tsx — /account/security: the signed-in per-user account-security surface (P1-02). Served on the auth
// origin (where the durable session + refresh cookie live, ADR-0016); the apps/web SecurityPanel deep-links
// here (#password / #mfa / #sessions / #history). GATED by requireUser — a guest is redirected to /login and
// no account data is rendered. Every read is scoped to the authenticated userId (data.ts), never a request
// value (09 access / mass-assignment AC). SSR + WCAG 2.2 AA; no inline scripts (strict nonce-CSP preserved).
import { AUTH_BASE_PATH } from "@/lib/authUrl";
import { requireUser } from "@/lib/requireUser";
import { AccountShell } from "@/shared/AccountShell";
import { HistorySection } from "./HistorySection";
import { MfaSection } from "./MfaSection";
import { PasswordSection } from "./PasswordSection";
import { SessionsSection } from "./SessionsSection";
import { loadAccountSecurity } from "./data";

// Always render fresh: sessions/MFA state change out-of-band (a revoke elsewhere, a new sign-in). Never cache.
export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | undefined>>;

const SECTIONS = [
  { id: "password", label: "Password" },
  { id: "mfa", label: "Two-step" },
  { id: "sessions", label: "Active sessions" },
  { id: "history", label: "Login history" },
];

export default async function AccountSecurityPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const acct = await requireUser();
  const sp = await searchParams;
  const data = await loadAccountSecurity(acct.userId, acct.sessionId);

  return (
    <AccountShell title="Account security" subtitle={acct.user.email} sections={SECTIONS}>
      <PasswordSection hasPassword={data.hasPassword} status={sp.password} />
      <MfaSection
        methods={data.mfaMethods}
        hasPassword={data.hasPassword}
        setPasswordHref={`${AUTH_BASE_PATH}/forgot`}
        recoveryCodesRemaining={data.recoveryCodesRemaining}
        status={sp.mfa}
      />
      <SessionsSection sessions={data.activeSessions} status={sp.sessions} />
      <HistorySection history={data.loginHistory} />
    </AccountShell>
  );
}
