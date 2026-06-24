// ListsPage.tsx — the Lists index surface: every static list in the workspace (workspace-shared), with search
// + sort, the four async states (loading/empty/error/populated via the State Kit), and create / rename / delete
// (rename + delete are owner-gated server-side). Each row links into the list-detail surface ((shell)/lists/[id]).
// Composition only — the data + mutations come from the slice (api/useLists); RLS + owner-gating live server-side.
"use client";

import type { List } from "@leadwolf/types";
import {
  type Column,
  DataTable,
  DropdownMenu,
  EmptyState,
  type MenuItem,
  StateSwitch,
  StatusBadge,
  TpButton,
  TpIconButton,
  TpInput,
  TpSelect,
} from "@leadwolf/ui";
import { ListChecks, MoreHorizontal, Plus } from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useLists } from "../hooks/useLists";
import styles from "../lists.module.css";
import { DeleteListDialog } from "./DeleteListDialog";
import { ListFormDialog } from "./ListFormDialog";

type SortKey = "updated" | "name" | "members";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "updated", label: "Recently updated" },
  { value: "name", label: "Name (A–Z)" },
  { value: "members", label: "Most members" },
];

function sortLists(lists: List[], sort: SortKey): List[] {
  const copy = [...lists];
  switch (sort) {
    case "name":
      return copy.sort((a, b) => a.name.localeCompare(b.name));
    case "members":
      return copy.sort((a, b) => b.memberCount - a.memberCount);
    default:
      return copy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

export function ListsPage() {
  const { lists, loading, error, reload } = useLists();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");
  // The open dialog: create (formList === null + formOpen), rename (formList set), or delete (deleteTarget set).
  const [formOpen, setFormOpen] = useState(false);
  const [formList, setFormList] = useState<List | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<List | null>(null);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? lists.filter(
          (l) =>
            l.name.toLowerCase().includes(q) || (l.description ?? "").toLowerCase().includes(q),
        )
      : lists;
    return sortLists(filtered, sort);
  }, [lists, search, sort]);

  const openCreate = () => {
    setFormList(null);
    setFormOpen(true);
  };
  const openRename = useCallback((list: List) => {
    setFormList(list);
    setFormOpen(true);
  }, []);

  const columns: Column<List>[] = useMemo(
    () => [
      {
        key: "name",
        header: "Name",
        sortValue: (l) => l.name,
        cell: (l) => (
          <Link href={`/lists/${l.id}`} className={styles.listLink}>
            <span className={styles.name}>{l.name}</span>
            {l.description ? <span className={styles.sub}>{l.description}</span> : null}
          </Link>
        ),
      },
      {
        key: "kind",
        header: "Type",
        width: 96,
        sortValue: (l) => l.kind,
        cell: (l) => (
          <StatusBadge tone="muted">{l.kind === "dynamic" ? "Dynamic" : "Static"}</StatusBadge>
        ),
      },
      {
        key: "members",
        header: "Members",
        align: "right",
        width: 96,
        sortValue: (l) => l.memberCount,
        cell: (l) => <span className={styles.mono}>{l.memberCount.toLocaleString()}</span>,
      },
      {
        key: "owner",
        header: "Owner",
        width: 96,
        cell: (l) => <span className={styles.pill}>{l.isOwner ? "You" : "Shared"}</span>,
      },
      {
        key: "updated",
        header: "Updated",
        width: 120,
        sortValue: (l) => l.updatedAt,
        cell: (l) => (
          <span className={styles.sub}>{new Date(l.updatedAt).toLocaleDateString()}</span>
        ),
      },
      {
        key: "actions",
        header: "",
        align: "right",
        width: 48,
        cell: (l) => {
          // Rename/delete are owner-only; for a shared (non-owned) list the menu collapses to "Open".
          const items: MenuItem[] = [{ label: "Open", onSelect: () => undefined }];
          if (l.isOwner) {
            items.push(
              { label: "Rename", onSelect: () => openRename(l), separatorBefore: true },
              { label: "Delete", onSelect: () => setDeleteTarget(l), danger: true },
            );
          }
          return (
            <span
              className={styles.rowCheck}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              role="presentation"
            >
              <DropdownMenu
                align="end"
                trigger={({ toggle }) => (
                  <TpIconButton label={`Actions for ${l.name}`} onClick={toggle}>
                    <MoreHorizontal size={16} />
                  </TpIconButton>
                )}
                items={items}
              />
            </span>
          );
        },
      },
    ],
    [openRename],
  );

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div className={styles.headMeta}>
          <h1 className={styles.title}>
            <ListChecks size={20} aria-hidden /> Lists
          </h1>
          <span className={styles.subtitle}>
            Curated, workspace-shared collections of prospects.
          </span>
        </div>
        <div className={styles.headActions}>
          <TpButton variant="primary" size="sm" leftIcon={<Plus size={15} />} onClick={openCreate}>
            New list
          </TpButton>
        </div>
      </div>

      <div className={styles.toolbar}>
        <TpInput
          type="search"
          placeholder="Search lists by name or description…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search lists"
        />
        <TpSelect
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          aria-label="Sort lists"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </TpSelect>
        <span className={styles.count}>
          {loading
            ? "Loading…"
            : `${shown.length.toLocaleString()} list${shown.length === 1 ? "" : "s"}`}
        </span>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!loading && shown.length === 0}
        onRetry={reload}
        emptyState={
          <EmptyState
            icon={<ListChecks size={28} />}
            title={search.trim() ? "No matching lists" : "No lists yet"}
            description={
              search.trim()
                ? "No lists match your search. Clear it or create a new list."
                : "Create a list to group prospects for outreach, then add contacts from the Prospect surface."
            }
            action={
              search.trim() ? undefined : (
                <TpButton
                  variant="primary"
                  size="sm"
                  leftIcon={<Plus size={15} />}
                  onClick={openCreate}
                >
                  New list
                </TpButton>
              )
            }
          />
        }
      >
        <DataTable columns={columns} rows={shown} rowKey={(l) => l.id} />
      </StateSwitch>

      <ListFormDialog
        open={formOpen}
        list={formList}
        onClose={() => setFormOpen(false)}
        onSaved={() => reload()}
      />
      <DeleteListDialog
        open={deleteTarget !== null}
        list={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={() => reload()}
      />
    </div>
  );
}
