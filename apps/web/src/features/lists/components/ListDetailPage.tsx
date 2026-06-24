// ListDetailPage.tsx — the list-detail surface: a list's MASKED members in the prospect-grade results grid
// (the shared DataTable + masking glyphs + density), the sticky BulkActionBar (the full Phase-3 bulk surface,
// REUSED — reveal/tags/status/enrich/export/enroll/add-to-another-list) extended with a list-specific
// "Remove from list", a lightweight member quick-view (the prospect QuickViewDrawer, reused), and a header with
// the list metadata + owner-gated rename/delete. Composition only — masking, RLS, owner-gating, and the
// affected counts all live server-side; this surface never sees raw PII (reveal is the only de-masking path).
"use client";

// Reuse the prospect surface verbatim: the bulk bar, the masked quick-view, the bulk-selection model, the tags
// hook, and the masking presentation helpers. The list members ARE masked contacts, so these compose directly.
// Everything comes through the prospect PUBLIC barrel (no deep cross-feature imports); the dependency is one-way.
import {
  BulkActionBar,
  QuickViewDrawer,
  displayName,
  emailGlyphFor,
  maskedEmail,
  useBulkSelection,
  useTags,
} from "@/features/prospect";
import type { ContactHit, ContactQuery, MaskedContact } from "@leadwolf/types";
import {
  type Column,
  DataTable,
  EmptyState,
  SegmentedControl,
  StateSwitch,
  Tooltip,
  TpButton,
  TpCheckbox,
  useToast,
} from "@leadwolf/ui";
import { ArrowLeft, ListChecks, Trash2, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { removeContactsFromList } from "../api";
import { useList } from "../hooks/useList";
import { useListMembers } from "../hooks/useListMembers";
import styles from "../lists.module.css";
import { DeleteListDialog } from "./DeleteListDialog";
import { ListFormDialog } from "./ListFormDialog";

const DENSITIES = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

// The members surface isn't backed by the workspace search query, so the bulk bar's `query` is a no-op
// default; we hide its "Select all matching" escalation (which would wrongly resolve to the whole workspace).
const EMPTY_QUERY: ContactQuery = { filters: [], sort: "relevance", limit: 50 };

export function ListDetailPage({ listId }: { listId: string }) {
  const router = useRouter();
  const toast = useToast();
  const { list, loading: listLoading, notFound, reload: reloadList } = useList(listId);
  const { members, loading, error, hasMore, loadMore, reload, markRevealed } =
    useListMembers(listId);
  const { tags } = useTags();

  const [density, setDensity] = useState("comfortable");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const bulk = useBulkSelection();
  const shownIds = useMemo(() => members.map((m) => m.id), [members]);
  const allShownSelected = shownIds.length > 0 && shownIds.every((id) => bulk.selectedIds.has(id));
  const selectedContacts = useMemo(
    () => members.filter((m) => bulk.selectedIds.has(m.id)),
    [members, bulk.selectedIds],
  );
  const revealableIds = useMemo(
    () => selectedContacts.filter((c) => c.hasEmail && !c.isRevealed).map((c) => c.id),
    [selectedContacts],
  );
  const preview = useMemo(
    () => members.find((m) => m.id === previewId) ?? null,
    [members, previewId],
  );

  // Remove a set of contacts from THIS list (the bulk "Remove from list" action + the single-row action). The
  // server scopes the list to the workspace + returns the removed count; we reload the page + clear on success.
  const removeFromList = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      try {
        const { affected } = await removeContactsFromList(listId, ids);
        toast.success(
          `Removed from list — ${affected.toLocaleString()} contact${affected === 1 ? "" : "s"}`,
        );
        reload();
        reloadList();
        bulk.clear();
      } catch (e) {
        toast.error("Could not remove from list", e instanceof Error ? e.message : undefined);
      }
    },
    [listId, toast, reload, reloadList, bulk.clear],
  );

  const columns: Column<MaskedContact>[] = useMemo(
    () => [
      {
        key: "select",
        header: (
          <TpCheckbox
            className={styles.headCheck}
            aria-label="Select all shown"
            checked={allShownSelected}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => bulk.setMany(shownIds, e.target.checked)}
          />
        ),
        width: 36,
        cell: (c) => (
          <TpCheckbox
            className={styles.rowCheck}
            checked={bulk.isSelected(c.id)}
            onClick={(e) => e.stopPropagation()}
            onChange={() => bulk.toggle(c.id)}
            aria-label={`Select ${displayName(c)}`}
          />
        ),
      },
      {
        key: "name",
        header: "Name",
        sortValue: (c) => displayName(c),
        cell: (c) => (
          <span className={styles.nameCell}>
            <span className={styles.nameMeta}>
              <span className={styles.name}>{displayName(c)}</span>
              <span className={styles.sub}>{c.jobTitle ?? "—"}</span>
            </span>
          </span>
        ),
      },
      {
        key: "company",
        header: "Company",
        sortValue: (c) => c.emailDomain ?? "",
        cell: (c) => <span className={styles.mono}>{c.emailDomain ?? "—"}</span>,
      },
      {
        key: "email",
        header: "Email",
        align: "center",
        width: 56,
        sortValue: (c) => c.emailStatus,
        cell: (c) => {
          const g = emailGlyphFor(c);
          const cls =
            g.tone === "ok"
              ? styles.glyphOk
              : g.tone === "warn"
                ? styles.glyphWarn
                : styles.glyphNone;
          return (
            <Tooltip label={g.label}>
              <span className={`${styles.glyph} ${cls}`} aria-label={g.label}>
                {g.mark}
              </span>
            </Tooltip>
          );
        },
      },
      {
        key: "address",
        header: "Address",
        cell: (c) => <span className={styles.mono}>{maskedEmail(c)}</span>,
      },
      {
        key: "phone",
        header: "Phone",
        align: "center",
        width: 64,
        sortValue: (c) => (c.hasPhone ? 1 : 0),
        cell: (c) =>
          c.hasPhone ? (
            <Tooltip label="Phone hidden until reveal">
              <span className={styles.lock} aria-label="Phone hidden until reveal">
                🔒
              </span>
            </Tooltip>
          ) : (
            <span className={styles.glyphNone}>—</span>
          ),
      },
      {
        key: "remove",
        header: "",
        align: "right",
        width: 48,
        cell: (c) => (
          <span
            className={styles.rowCheck}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <Tooltip label="Remove from list">
              <TpButton
                variant="ghost"
                size="sm"
                aria-label={`Remove ${displayName(c)} from list`}
                onClick={() => void removeFromList([c.id])}
              >
                <Trash2 size={15} />
              </TpButton>
            </Tooltip>
          </span>
        ),
      },
    ],
    [allShownSelected, shownIds, bulk, removeFromList],
  );

  if (notFound) {
    return (
      <div className={styles.page}>
        <Link href="/lists" className={styles.back}>
          <ArrowLeft size={15} aria-hidden /> Back to lists
        </Link>
        <EmptyState
          icon={<ListChecks size={28} />}
          title="List not found"
          description="This list doesn’t exist in your workspace, or it was deleted."
          action={
            <TpButton variant="primary" size="sm" onClick={() => router.push("/lists")}>
              Back to lists
            </TpButton>
          }
        />
      </div>
    );
  }

  return (
    <div className={styles.page} data-density={density}>
      <Link href="/lists" className={styles.back}>
        <ArrowLeft size={15} aria-hidden /> Back to lists
      </Link>

      <div className={styles.head}>
        <div className={styles.headMeta}>
          <h1 className={styles.title}>
            <ListChecks size={20} aria-hidden /> {list?.name ?? (listLoading ? "…" : "List")}
          </h1>
          <span className={styles.subtitle}>
            {list?.description ? `${list.description} · ` : ""}
            {list
              ? `${list.memberCount.toLocaleString()} member${list.memberCount === 1 ? "" : "s"}`
              : ""}
            {list ? ` · ${list.isOwner ? "Owned by you" : "Shared"}` : ""}
          </span>
        </div>
        <div className={styles.headActions}>
          <SegmentedControl
            items={DENSITIES}
            value={density}
            onChange={setDensity}
            aria-label="Row density"
          />
          {list?.isOwner ? (
            <>
              <TpButton variant="secondary" size="sm" onClick={() => setRenameOpen(true)}>
                Rename
              </TpButton>
              <TpButton variant="ghost" size="sm" onClick={() => setDeleteOpen(true)}>
                Delete
              </TpButton>
            </>
          ) : null}
        </div>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!loading && members.length === 0}
        onRetry={reload}
        emptyState={
          <EmptyState
            icon={<Users size={28} />}
            title="No members yet"
            description="Add prospects to this list from the Prospect surface (select rows → Add to list), or from a record’s detail panel."
          />
        }
      >
        <DataTable
          columns={columns}
          rows={members}
          rowKey={(c) => c.id}
          onRowClick={(c) => setPreviewId(c.id)}
          isSelected={(c) => c.id === previewId}
        />
        {hasMore ? (
          <div className={styles.loadMore}>
            <TpButton variant="secondary" size="sm" loading={loading} onClick={loadMore}>
              Load more
            </TpButton>
          </div>
        ) : null}
      </StateSwitch>

      <QuickViewDrawer contact={preview} onClose={() => setPreviewId(null)} />

      {bulk.count > 0 ? (
        <BulkActionBar
          selection={bulk}
          query={EMPTY_QUERY}
          selectedContacts={selectedContacts as ContactHit[]}
          revealableIds={revealableIds}
          tags={tags}
          hideSelectAllMatching
          extraActions={
            <TpButton
              variant="ghost"
              size="sm"
              leftIcon={<Trash2 size={15} />}
              onClick={() => void removeFromList(selectedContacts.map((c) => c.id))}
            >
              Remove from list
            </TpButton>
          }
          onRevealed={(ids) => {
            for (const id of ids) markRevealed(id);
            bulk.clear();
          }}
          onMutated={() => reload()}
        />
      ) : null}

      <ListFormDialog
        open={renameOpen}
        list={list}
        onClose={() => setRenameOpen(false)}
        onSaved={() => reloadList()}
      />
      <DeleteListDialog
        open={deleteOpen}
        list={list}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => router.push("/lists")}
      />
    </div>
  );
}
