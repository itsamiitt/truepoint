// OAuthAppsPanel.tsx — Developer ▸ OAuth apps: register an OAuth client (name + redirect URIs) and list the
// registered clients (client id + redirect URIs). Redirect URIs must resolve on the auth origin (12 §5,
// ADR-0016), so the form pins the origin and only takes the path. The client secret is shown once on
// registration. Empty-first against the unbuilt /oauth-apps API (M11); no fabricated credentials.
"use client";

import {
  type Column,
  DataTable,
  Dialog,
  EmptyState,
  FieldGroup,
  StateSwitch,
  TpButton,
  TpInput,
  useToast,
} from "@leadwolf/ui";
import { Boxes, Copy } from "lucide-react";
import { useState } from "react";
import { AUTH_ORIGIN } from "@/lib/publicConfig";
import { useOAuthApps } from "../hooks/useOAuthApps";
import type { OAuthApp } from "../types";
import styles from "../settings-developer.module.css";

function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

/** Normalize a user-entered redirect path/URL into an auth-origin URL (redirect URIs must be on the auth origin). */
function toAuthOriginUri(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith(AUTH_ORIGIN)) return trimmed;
  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `${AUTH_ORIGIN}${path}`;
}

export function OAuthAppsPanel() {
  const toast = useToast();
  const { feed, loading, error, reload, register, remove } = useOAuthApps();

  const [registering, setRegistering] = useState(false);
  const [name, setName] = useState("");
  const [redirectPath, setRedirectPath] = useState("/oauth/callback");
  const [submitting, setSubmitting] = useState(false);

  const [credentials, setCredentials] = useState<{ clientId: string; clientSecret: string | null } | null>(
    null,
  );
  const [toRemove, setToRemove] = useState<OAuthApp | null>(null);

  const notWired = () =>
    toast.toast({
      title: "Not available yet",
      description: "OAuth app registration connects once the API ships (M11).",
    });

  const resetRegister = () => {
    setRegistering(false);
    setName("");
    setRedirectPath("/oauth/callback");
  };

  const onRegister = async () => {
    const uri = toAuthOriginUri(redirectPath);
    if (name.trim().length === 0 || uri.length === 0) return;
    setSubmitting(true);
    try {
      const result = await register(name.trim(), [uri]);
      if (!result.ok) {
        notWired();
        resetRegister();
        return;
      }
      resetRegister();
      toast.success("OAuth app registered");
      if (result.clientId) {
        setCredentials({ clientId: result.clientId, clientSecret: result.clientSecret ?? null });
      }
    } catch (e) {
      toast.error("Could not register the app", e instanceof Error ? e.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  const onRemove = async () => {
    if (!toRemove) return;
    const ok = await remove(toRemove.id);
    if (ok) toast.success("OAuth app removed");
    else notWired();
    setToRemove(null);
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Could not copy", "Select the value and copy it manually.");
    }
  };

  const columns: Column<OAuthApp>[] = [
    {
      key: "name",
      header: "Name",
      sortValue: (a) => a.name,
      cell: (a) => a.name,
    },
    {
      key: "clientId",
      header: "Client ID",
      cell: (a) => <span className={styles.mono}>{a.clientId}</span>,
    },
    {
      key: "redirects",
      header: "Redirect URIs",
      cell: (a) => (
        <span className={styles.uriList}>
          {a.redirectUris.map((u) => (
            <span key={u} className={styles.mono}>
              {u}
            </span>
          ))}
        </span>
      ),
    },
    {
      key: "created",
      header: "Created",
      sortValue: (a) => a.createdAt,
      cell: (a) => <span className={styles.muted}>{formatDate(a.createdAt)}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (a) => (
        <TpButton variant="ghost" size="sm" onClick={() => setToRemove(a)}>
          Remove
        </TpButton>
      ),
    },
  ];

  return (
    <section>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadText}>
          <h2 className={styles.panelTitle}>OAuth apps</h2>
          <p className={styles.panelDesc}>
            Register OAuth clients for sign-in with TruePoint. Redirect URIs must resolve on{" "}
            <span className={styles.mono}>{AUTH_ORIGIN}</span>.
          </p>
        </div>
        <TpButton leftIcon={<Boxes size={15} />} onClick={() => setRegistering(true)}>
          Register app
        </TpButton>
      </div>

      {feed != null && !feed.available ? (
        <div className={styles.connectNote}>
          <span className={styles.connectNoteIcon}>
            <Boxes size={15} />
          </span>
          <span>OAuth app registration isn&apos;t connected yet (M11). Registered clients will appear here.</span>
        </div>
      ) : null}

      <StateSwitch
        loading={loading}
        error={error}
        empty={feed != null && feed.apps.length === 0}
        onRetry={reload}
        emptyState={
          <EmptyState
            icon={<Boxes size={28} />}
            title={feed?.available ? "No OAuth apps yet" : "OAuth apps not connected"}
            description={
              feed?.available
                ? "Register a client to let users sign in with TruePoint."
                : "Once the OAuth app API ships, your registered clients will appear here."
            }
            action={
              feed?.available ? (
                <TpButton size="sm" onClick={() => setRegistering(true)}>
                  Register app
                </TpButton>
              ) : undefined
            }
          />
        }
      >
        <DataTable columns={columns} rows={feed?.apps ?? []} rowKey={(a) => a.id} />
      </StateSwitch>

      {/* Register dialog */}
      <Dialog
        open={registering}
        onClose={resetRegister}
        title="Register OAuth app"
        description="Name the client and set its redirect URI on the auth origin."
        footer={
          <>
            <TpButton variant="ghost" onClick={resetRegister}>
              Cancel
            </TpButton>
            <TpButton
              onClick={onRegister}
              loading={submitting}
              disabled={name.trim().length === 0 || redirectPath.trim().length === 0}
            >
              Register
            </TpButton>
          </>
        }
      >
        <div className={styles.dialogForm}>
          <FieldGroup label="Name" htmlFor="oauth-name">
            <TpInput
              id="oauth-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My integration"
            />
          </FieldGroup>
          <FieldGroup
            label="Redirect URI"
            htmlFor="oauth-redirect"
            hint={`Resolved on the auth origin → ${toAuthOriginUri(redirectPath) || AUTH_ORIGIN}`}
          >
            <TpInput
              id="oauth-redirect"
              value={redirectPath}
              onChange={(e) => setRedirectPath(e.target.value)}
              placeholder="/oauth/callback"
            />
          </FieldGroup>
        </div>
      </Dialog>

      {/* One-time credentials */}
      <Dialog
        open={credentials != null}
        onClose={() => setCredentials(null)}
        title="Your OAuth credentials"
        description="The client secret is shown only once. Store it somewhere safe."
        footer={<TpButton onClick={() => setCredentials(null)}>Done</TpButton>}
      >
        {credentials ? (
          <div className={styles.secretBox}>
            <FieldGroup label="Client ID">
              <div className={styles.secretRow}>
                <code className={styles.secretValue}>{credentials.clientId}</code>
                <TpButton
                  variant="secondary"
                  leftIcon={<Copy size={14} />}
                  onClick={() => copy(credentials.clientId)}
                >
                  Copy
                </TpButton>
              </div>
            </FieldGroup>
            {credentials.clientSecret ? (
              <FieldGroup label="Client secret">
                <div className={styles.secretRow}>
                  <code className={styles.secretValue}>{credentials.clientSecret}</code>
                  <TpButton
                    variant="secondary"
                    leftIcon={<Copy size={14} />}
                    onClick={() => copy(credentials.clientSecret ?? "")}
                  >
                    Copy
                  </TpButton>
                </div>
              </FieldGroup>
            ) : (
              <p className={styles.note}>The client secret is available from the backend response.</p>
            )}
          </div>
        ) : null}
      </Dialog>

      {/* Remove confirm */}
      <Dialog
        open={toRemove != null}
        onClose={() => setToRemove(null)}
        title="Remove OAuth app?"
        description={
          toRemove ? `"${toRemove.name}" will stop working immediately.` : undefined
        }
        footer={
          <>
            <TpButton variant="ghost" onClick={() => setToRemove(null)}>
              Cancel
            </TpButton>
            <TpButton variant="danger" onClick={onRemove}>
              Remove
            </TpButton>
          </>
        }
      />
    </section>
  );
}
