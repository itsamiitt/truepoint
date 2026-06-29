"use client";
// TenantPicker.tsx — an EntityPicker preset that resolves a tenant by name/slug to its id, so staff stop
// pasting raw UUIDs on surfaces that target a single org (announcements, feature-flag overrides, …). Searches
// the audited GET /admin/tenants?search= endpoint server-side (ILIKE, keyset-bounded). Public API:
// value=tenantId, onChange(id, name). The api still validates + authorizes the id — the picker is UX only.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import { type EntityOption, EntityPicker } from "./EntityPicker";

async function searchTenants(query: string): Promise<EntityOption[]> {
  const qs = query ? `?search=${encodeURIComponent(query)}` : "";
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/tenants${qs}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { tenants?: { id: string; name: string; slug: string }[] };
  return (body.tenants ?? [])
    .slice(0, 10)
    .map((t) => ({ value: t.id, label: t.name, hint: t.slug }));
}

export function TenantPicker({
  id,
  value,
  selectedName,
  onChange,
  disabled,
  placeholder = "Search tenants by name…",
}: {
  id?: string;
  value: string;
  selectedName?: string | null;
  onChange: (tenantId: string, tenantName: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <EntityPicker
      id={id}
      value={value}
      selectedLabel={selectedName}
      onChange={onChange}
      search={searchTenants}
      disabled={disabled}
      placeholder={placeholder}
      emptyText="No tenants match."
    />
  );
}
