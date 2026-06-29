"use client";
// UserPicker.tsx — an EntityPicker preset that resolves a user by email/name to their id, so staff stop
// pasting raw user UUIDs (e.g. the Staff RBAC grant form). Searches the audited GET /admin/users?search=
// endpoint server-side. Public API: value=userId, onChange(id, label). The api re-validates + authorizes the
// id on the write — the picker is UX only.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import { type EntityOption, EntityPicker } from "./EntityPicker";

async function searchUsers(query: string): Promise<EntityOption[]> {
  const qs = query ? `?search=${encodeURIComponent(query)}` : "";
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/users${qs}`);
  if (!res.ok) return [];
  const body = (await res.json()) as {
    users?: { id: string; email: string; fullName: string | null }[];
  };
  return (body.users ?? []).slice(0, 10).map((u) => ({
    value: u.id,
    label: u.fullName ?? u.email,
    hint: u.fullName ? u.email : undefined,
  }));
}

export function UserPicker({
  id,
  value,
  selectedLabel,
  onChange,
  disabled,
  placeholder = "Search users by email or name…",
}: {
  id?: string;
  value: string;
  selectedLabel?: string | null;
  onChange: (userId: string, label: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <EntityPicker
      id={id}
      value={value}
      selectedLabel={selectedLabel}
      onChange={onChange}
      search={searchUsers}
      disabled={disabled}
      placeholder={placeholder}
      emptyText="No users match."
    />
  );
}
