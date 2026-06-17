// ApiKeysPanel.tsx — Developer ▸ API keys: a DataTable of tenant-scoped keys (name · scopes · last used ·
// created) with create / rotate / revoke via Dialog + useToast. The plaintext secret is shown exactly once on
// create/rotate. Empty-first against the unbuilt /tenants/me/api-keys API (M10); no fabricated keys, and any
// mutation that isn't wired yet surfaces a quiet "not available" toast.
"use client";

import {
  type Column,
  DataTable,
  Dialog,
  EmptyState,
  FieldGroup,
  StateSwitch,
  StatusBadge,
  TpButton,
  TpCheckbox,
  TpInput,
  useToast,
} from "@leadwolf/ui";
import { Copy, KeyRound } from "lucide-react";
import { useState } from "react";
import { useApiKeys } from "../hooks/useApiKeys";
import { type ApiKey, type ApiKeyScope, SCOPE_LABEL, SCOPE_OPTIONS } from "../types";
import styles from "../settings-developer.module.css";

function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

export function ApiKeysPanel() {
  const toast = useToast();
  const { feed, loading, error, reload, create, rotate, revoke } = useApiKeys();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const [secret, setSecret] = useState<string | null>(null);
  const [toRevoke, setToRevoke] = useState<ApiKey | null>(null);

  const notWired = () =>
    toast.toast({
      title: "Not available yet",
      description: "API keys connect once the developer API ships (M10).",
    });

  const toggleScope = (scope: ApiKeyScope) =>
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));

  const resetCreate = () => {
    setCreating(false);
    setName("");
    setScopes([]);
  };

  const onCreate = async () => {
    if (name.trim().length === 0) return;
    setSubmitting(true);
    try {
      const result = await create(name.trim(), scopes);
      if (!result.ok) {
        notWired();
        resetCreate();
        return;
      }
      resetCreate();
      if (result.secret) {
        setSecret(result.secret);
        toast.success("API key created");
      } else {
        toast.success("API key created", "The secret is available from the backend response.");
      }
    } catch (e) {
      toast.error("Could not create the key", e instanceof Error ? e.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  const onRotate = async (key: ApiKey) => {
    try {
      const result = await rotate(key.id);
      if (!result.ok) {
        notWired();
        return;
      }
      if (result.secret) {
        setSecret(result.secret);
        toast.success("API key rotated");
      } else {
        toast.success("API key rotated");
      }
    } catch (e) {
      toast.error("Could not rotate the key", e instanceof Error ? e.message : undefined);
    }
  };

  const onRevoke = async () => {
    if (!toRevoke) return;
    const ok = await revoke(toRevoke.id);
    if (ok) toast.success("API key revoked");
    else notWired();
    setToRevoke(null);
  };

  const copySecret = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Could not copy", "Select the value and copy it manually.");
    }
  };

  const columns: Column<ApiKey>[] = [
    {
      key: "name",
      header: "Name",
      sortValue: (k) => k.name,
      cell: (k) => (
        <span className={styles.nameCell}>
          <span>{k.name}</span>
          <span className={styles.mono}>{k.prefix}</span>
        </span>
      ),
    },
    {
      key: "scopes",
      header: "Scopes",
      cell: (k) =>
        k.scopes.length === 0 ? (
          <span className={styles.muted}>None</span>
        ) : (
          <span className={styles.scopeTags}>
            {k.scopes.map((s) => (
              <StatusBadge key={s} tone="muted">
                {SCOPE_LABEL[s]}
              </StatusBadge>
            ))}
          </span>
        ),
    },
    {
      key: "lastUsed",
      header: "Last used",
      sortValue: (k) => k.lastUsedAt ?? "",
      cell: (k) => <span className={styles.muted}>{formatDate(k.lastUsedAt)}</span>,
    },
    {
      key: "created",
      header: "Created",
      sortValue: (k) => k.createdAt,
      cell: (k) => <span className={styles.muted}>{formatDate(k.createdAt)}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (k) => (
        <span className={styles.rowActions}>
          <TpButton variant="ghost" size="sm" onClick={() => onRotate(k)}>
            Rotate
          </TpButton>
          <TpButton variant="ghost" size="sm" onClick={() => setToRevoke(k)}>
            Revoke
          </TpButton>
        </span>
      ),
    },
  ];

  return (
    <section>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadText}>
          <h2 className={styles.panelTitle}>API keys</h2>
          <p className={styles.panelDesc}>
            Tenant-scoped, hashed keys for the public API. The secret is shown once at creation.
          </p>
        </div>
        <TpButton leftIcon={<KeyRound size={15} />} onClick={() => setCreating(true)}>
          Create key
        </TpButton>
      </div>

      {feed != null && !feed.available ? (
        <div className={styles.connectNote}>
          <span className={styles.connectNoteIcon}>
            <KeyRound size={15} />
          </span>
          <span>The API-keys backend isn&apos;t connected yet (M10). Keys will appear here once it ships.</span>
        </div>
      ) : null}

      <StateSwitch
        loading={loading}
        error={error}
        empty={feed != null && feed.keys.length === 0}
        onRetry={reload}
        emptyState={
          <EmptyState
            icon={<KeyRound size={28} />}
            title={feed?.available ? "No API keys yet" : "API keys not connected"}
            description={
              feed?.available
                ? "Create a key to authenticate programmatic access to the API."
                : "Once the developer API ships, your tenant's keys will appear here."
            }
            action={
              feed?.available ? (
                <TpButton size="sm" onClick={() => setCreating(true)}>
                  Create key
                </TpButton>
              ) : undefined
            }
          />
        }
      >
        <DataTable columns={columns} rows={feed?.keys ?? []} rowKey={(k) => k.id} />
      </StateSwitch>

      {/* Create dialog */}
      <Dialog
        open={creating}
        onClose={resetCreate}
        title="Create API key"
        description="Name the key and choose the scopes it may call."
        footer={
          <>
            <TpButton variant="ghost" onClick={resetCreate}>
              Cancel
            </TpButton>
            <TpButton onClick={onCreate} loading={submitting} disabled={name.trim().length === 0}>
              Create key
            </TpButton>
          </>
        }
      >
        <div className={styles.dialogForm}>
          <FieldGroup label="Name" htmlFor="key-name" hint="A label to recognize this key later.">
            <TpInput
              id="key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Production server"
            />
          </FieldGroup>
          <FieldGroup label="Scopes">
            <div className={styles.scopeList}>
              {SCOPE_OPTIONS.map((s) => (
                <div key={s.value} className={styles.scopeRow}>
                  <TpCheckbox
                    label={s.label}
                    checked={scopes.includes(s.value)}
                    onChange={() => toggleScope(s.value)}
                  />
                  <span className={styles.scopeDesc}>{s.description}</span>
                </div>
              ))}
            </div>
          </FieldGroup>
        </div>
      </Dialog>

      {/* One-time secret */}
      <Dialog
        open={secret != null}
        onClose={() => setSecret(null)}
        title="Copy your API key"
        description="This is the only time the full key is shown. Store it somewhere safe."
        footer={
          <TpButton onClick={() => setSecret(null)}>Done</TpButton>
        }
      >
        <div className={styles.secretBox}>
          <p className={styles.secretWarn}>You won&apos;t be able to see this secret again.</p>
          <div className={styles.secretRow}>
            <code className={styles.secretValue}>{secret}</code>
            <TpButton variant="secondary" leftIcon={<Copy size={14} />} onClick={copySecret}>
              Copy
            </TpButton>
          </div>
        </div>
      </Dialog>

      {/* Revoke confirm */}
      <Dialog
        open={toRevoke != null}
        onClose={() => setToRevoke(null)}
        title="Revoke API key?"
        description={
          toRevoke
            ? `"${toRevoke.name}" will stop working immediately. This can't be undone.`
            : undefined
        }
        footer={
          <>
            <TpButton variant="ghost" onClick={() => setToRevoke(null)}>
              Cancel
            </TpButton>
            <TpButton variant="danger" onClick={onRevoke}>
              Revoke
            </TpButton>
          </>
        }
      />
    </section>
  );
}
