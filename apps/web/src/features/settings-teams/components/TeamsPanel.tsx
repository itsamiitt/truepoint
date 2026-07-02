// TeamsPanel.tsx — Settings ▸ Workspace ▸ Teams (Part D, decision #6): create/delete teams and manage each
// team's member roster. TEAMS ARE GROUPING ONLY — an org-chart/label, NOT a permission; the copy says so and
// nothing here changes who can see which records. Writes are workspace-admin gated (the api enforces it too;
// this hides the controls for non-admins). Vanilla React + fetchWithAuth + the State Kit.
"use client";

import { isWorkspaceAdmin, useSessionRole } from "@/lib/useSessionRole";
import type { TeamMemberView, TeamView } from "@leadwolf/types";
import { Card, EmptyState, StateSwitch, TpButton, TpInput, useToast } from "@leadwolf/ui";
import { useCallback, useEffect, useState } from "react";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  fetchTeamMembers,
  fetchTeams,
  fetchWorkspaceMemberEmails,
  removeTeamMember,
} from "../api";

function TeamRoster({ team, canManage }: { team: TeamView; canManage: boolean }) {
  const toast = useToast();
  const [members, setMembers] = useState<TeamMemberView[]>([]);
  const [emails, setEmails] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addEmail, setAddEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [m, e] = await Promise.all([fetchTeamMembers(team.id), fetchWorkspaceMemberEmails()]);
      setMembers(m);
      setEmails(e);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the roster");
    } finally {
      setLoading(false);
    }
  }, [team.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onAdd() {
    const email = addEmail.trim().toLowerCase();
    if (!email) return;
    setBusy(true);
    try {
      await addTeamMember(team.id, email);
      setAddEmail("");
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add the member");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(userId: string) {
    setBusy(true);
    try {
      await removeTeamMember(team.id, userId);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the member");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--tp-border)" }}>
      <StateSwitch loading={loading} error={error} onRetry={reload}>
        {members.length === 0 ? (
          <p className="app-muted" style={{ fontSize: 13, margin: "0 0 12px" }}>
            No members in this team yet.
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: "0 0 12px", padding: 0 }}>
            {members.map((m) => (
              <li
                key={m.userId}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "6px 0",
                }}
              >
                <span>{m.fullName ? `${m.fullName} · ${m.email}` : m.email}</span>
                {canManage && (
                  <TpButton
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void onRemove(m.userId)}
                  >
                    Remove
                  </TpButton>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <div style={{ display: "flex", gap: 8 }}>
            <TpInput
              value={addEmail}
              placeholder="member@company.com"
              list={`team-emails-${team.id}`}
              disabled={busy}
              onChange={(e) => setAddEmail(e.currentTarget.value)}
            />
            <datalist id={`team-emails-${team.id}`}>
              {emails.map((e) => (
                <option key={e} value={e} />
              ))}
            </datalist>
            <TpButton variant="secondary" size="sm" loading={busy} onClick={() => void onAdd()}>
              Add
            </TpButton>
          </div>
        )}
      </StateSwitch>
    </div>
  );
}

export function TeamsPanel() {
  const toast = useToast();
  const canManage = isWorkspaceAdmin(useSessionRole());

  const [teams, setTeams] = useState<TeamView[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchTeams();
      if (list === null) {
        setAvailable(false);
        setTeams([]);
      } else {
        setAvailable(true);
        setTeams(list);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load teams");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onCreate() {
    const name = newName.trim();
    if (!name) {
      toast.error("Enter a team name.");
      return;
    }
    setBusy(true);
    try {
      await createTeam(name, newDesc.trim() || undefined);
      setNewName("");
      setNewDesc("");
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the team");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    setBusy(true);
    try {
      await deleteTeam(id);
      if (expandedId === id) setExpandedId(null);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete the team");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1 className="tp-settings-title">Teams</h1>
      <p className="app-muted" style={{ fontSize: 13, marginTop: 0 }}>
        Teams are a way to group the people in this workspace — an org-chart label. They do{" "}
        <strong>not</strong> change who can see which contacts, lists, or searches; everyone in the
        workspace still sees the same records.
      </p>

      {canManage && available && (
        <Card style={{ padding: 16, marginBottom: 20 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-start" }}>
            <TpInput
              value={newName}
              placeholder="Team name"
              disabled={busy}
              onChange={(e) => setNewName(e.currentTarget.value)}
            />
            <TpInput
              value={newDesc}
              placeholder="Description (optional)"
              disabled={busy}
              onChange={(e) => setNewDesc(e.currentTarget.value)}
            />
            <TpButton variant="primary" size="sm" loading={busy} onClick={() => void onCreate()}>
              New team
            </TpButton>
          </div>
        </Card>
      )}

      <StateSwitch
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!loading && teams.length === 0}
        emptyState={
          <EmptyState
            title={available ? "No teams yet" : "Teams aren't enabled"}
            description={
              available
                ? "Create a team to group members of this workspace."
                : "Teams aren't enabled for your workspace yet."
            }
          />
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {teams.map((team) => (
            <Card key={team.id} style={{ padding: 16 }}>
              <div
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{team.name}</div>
                  <div className="app-muted" style={{ fontSize: 12 }}>
                    {team.memberCount} member{team.memberCount === 1 ? "" : "s"}
                    {team.description ? ` · ${team.description}` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <TpButton
                    variant="secondary"
                    size="sm"
                    onClick={() => setExpandedId(expandedId === team.id ? null : team.id)}
                  >
                    {expandedId === team.id ? "Hide" : "Manage"}
                  </TpButton>
                  {canManage && (
                    <TpButton
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void onDelete(team.id)}
                    >
                      Delete
                    </TpButton>
                  )}
                </div>
              </div>
              {expandedId === team.id && <TeamRoster team={team} canManage={canManage} />}
            </Card>
          ))}
        </div>
      </StateSwitch>
    </section>
  );
}
