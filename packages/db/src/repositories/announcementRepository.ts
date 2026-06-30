// announcementRepository.ts — data access for announcements (13a Area 10). The admin authoring methods take
// the transaction handed by withPlatformTx (owner connection, audited). The CUSTOMER read (listActiveForTenant)
// runs on the base owner connection directly — announcements are platform broadcasts (not tenant-private), and
// the filter is server-controlled (the tenantId comes from the verified session, never the request), so no
// cross-tenant announcement can leak. The customer NEVER reads this table via the app role (deny-all RLS).

import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { type Tx, db } from "../client.ts";
import { announcements } from "../schema/platformOps.ts";

export interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  level: string;
  type: string;
  audience: string;
  tenantTarget: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ActiveAnnouncementRow {
  id: string;
  title: string;
  body: string;
  level: string;
  type: string;
}

export interface AnnouncementWrite {
  title: string;
  body: string;
  level: string;
  type: string;
  audience: string;
  tenantTarget: string | null;
  startsAt: string | null; // ISO or null
  endsAt: string | null;
}

const COLS = {
  id: announcements.id,
  title: announcements.title,
  body: announcements.body,
  level: announcements.level,
  type: announcements.type,
  audience: announcements.audience,
  tenantTarget: announcements.tenantTarget,
  startsAt: announcements.startsAt,
  endsAt: announcements.endsAt,
  active: announcements.active,
  createdAt: announcements.createdAt,
  updatedAt: announcements.updatedAt,
};

const ts = (iso: string | null): Date | null => (iso ? new Date(iso) : null);

export const announcementRepository = {
  /** The full authoring list (active + retired), newest first, bounded. */
  async list(tx: Tx): Promise<AnnouncementRow[]> {
    return tx.select(COLS).from(announcements).orderBy(desc(announcements.id)).limit(200);
  },

  /** Publish a new announcement (active by default). */
  async create(
    tx: Tx,
    input: AnnouncementWrite & { createdByUserId: string },
  ): Promise<AnnouncementRow> {
    const [row] = await tx
      .insert(announcements)
      .values({
        title: input.title,
        body: input.body,
        level: input.level,
        type: input.type,
        audience: input.audience,
        tenantTarget: input.tenantTarget,
        startsAt: ts(input.startsAt),
        endsAt: ts(input.endsAt),
        createdByUserId: input.createdByUserId,
      })
      .returning(COLS);
    return row as AnnouncementRow;
  },

  /** Update an announcement by id. Returns rows touched (0 = unknown id → caller raises 404). */
  async update(tx: Tx, id: string, input: AnnouncementWrite): Promise<number> {
    const updated = await tx
      .update(announcements)
      .set({
        title: input.title,
        body: input.body,
        level: input.level,
        type: input.type,
        audience: input.audience,
        tenantTarget: input.tenantTarget,
        startsAt: ts(input.startsAt),
        endsAt: ts(input.endsAt),
        updatedAt: sql`now()`,
      })
      .where(eq(announcements.id, id))
      .returning({ id: announcements.id });
    return updated.length;
  },

  /** Toggle an announcement on/off. Returns rows touched (0 = unknown id). */
  async setActive(tx: Tx, id: string, active: boolean): Promise<number> {
    const updated = await tx
      .update(announcements)
      .set({ active, updatedAt: sql`now()` })
      .where(eq(announcements.id, id))
      .returning({ id: announcements.id });
    return updated.length;
  },

  /**
   * CUSTOMER read — the active announcements applicable to one tenant, for the in-app banner. Runs on the
   * OWNER connection (announcements are platform broadcasts, deny-all to the app role) with a server-controlled
   * filter: active, within the [starts_at, ends_at) window, and audience all OR a tenant match. `tenantId` MUST
   * come from the verified session, never the request body — that is what makes this owner read safe.
   */
  async listActiveForTenant(tenantId: string): Promise<ActiveAnnouncementRow[]> {
    return db
      .select({
        id: announcements.id,
        title: announcements.title,
        body: announcements.body,
        level: announcements.level,
        type: announcements.type,
      })
      .from(announcements)
      .where(
        and(
          eq(announcements.active, true),
          or(isNull(announcements.startsAt), sql`${announcements.startsAt} <= now()`),
          or(isNull(announcements.endsAt), sql`${announcements.endsAt} > now()`),
          or(
            eq(announcements.audience, "all"),
            and(eq(announcements.audience, "tenant"), eq(announcements.tenantTarget, tenantId)),
          ),
        ),
      )
      .orderBy(desc(announcements.id))
      .limit(20);
  },
};
