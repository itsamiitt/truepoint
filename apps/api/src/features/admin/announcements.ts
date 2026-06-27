// announcements.ts — platform-admin announcements authoring (13a Area 10, 13 §3.10). Mounted under
// /api/v1/admin/announcements, so the parent router already applied authn + platformAdmin. Authoring is a
// content control → the content:manage capability (super_admin|support). All reads/writes go through the
// audited withPlatformTx; create/update/toggle write an "announcement.publish" platform_audit_log row. The
// customer banner read is a separate, server-scoped endpoint (features/announcements) — never this surface.

import { announcementRepository, withPlatformTx } from "@leadwolf/db";
import {
  type AnnouncementView,
  NotFoundError,
  ValidationError,
  announcementSetActiveSchema,
  announcementUpsertSchema,
} from "@leadwolf/types";
import { type Context, Hono } from "hono";
import type { ApiVariables } from "../../middleware/authn.ts";
import { requireCapability } from "../../middleware/requireCapability.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const announcementRoutes = new Hono<{ Variables: ApiVariables }>();

announcementRoutes.use("*", requireCapability("content:manage"));

const actorOf = (c: Context<{ Variables: ApiVariables }>) => ({
  userId: c.get("claims").sub,
  ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
});

function toView(r: {
  id: string;
  title: string;
  body: string;
  level: string;
  audience: string;
  tenantTarget: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}): AnnouncementView {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    level: r.level as AnnouncementView["level"],
    audience: r.audience as AnnouncementView["audience"],
    tenantTarget: r.tenantTarget,
    startsAt: r.startsAt ? r.startsAt.toISOString() : null,
    endsAt: r.endsAt ? r.endsAt.toISOString() : null,
    active: r.active,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** The full authoring list (active + retired). */
announcementRoutes.get("/", async (c) => {
  const announcements = await withPlatformTx(actorOf(c), "admin.list_announcements", async (tx) =>
    (await announcementRepository.list(tx)).map(toView),
  );
  return c.json({ announcements });
});

/** Publish a new announcement. Audited "announcement.publish". */
announcementRoutes.post("/", async (c) => {
  const parsed = announcementUpsertSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const actor = actorOf(c);
  const row = await withPlatformTx(
    actor,
    "announcement.publish",
    (tx) => announcementRepository.create(tx, { ...parsed.data, createdByUserId: actor.userId }),
    {
      targetType: "announcement",
      metadata: { audience: parsed.data.audience, level: parsed.data.level },
    },
  );
  return c.json({ announcement: toView(row) });
});

/** Update an announcement by id. 404 if unknown (thrown in-tx → audit row rolls back). Audited. */
announcementRoutes.put("/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw new ValidationError("id must be a UUID");
  const parsed = announcementUpsertSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  await withPlatformTx(
    actorOf(c),
    "announcement.publish",
    async (tx) => {
      const touched = await announcementRepository.update(tx, id, parsed.data);
      if (touched === 0) throw new NotFoundError("Announcement not found.");
    },
    { targetType: "announcement", targetId: id },
  );
  return c.json({ ok: true, id });
});

/** Toggle an announcement on/off. 404 if unknown. Audited. */
announcementRoutes.post("/:id/active", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw new ValidationError("id must be a UUID");
  const parsed = announcementSetActiveSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  await withPlatformTx(
    actorOf(c),
    "announcement.publish",
    async (tx) => {
      const touched = await announcementRepository.setActive(tx, id, parsed.data.active);
      if (touched === 0) throw new NotFoundError("Announcement not found.");
    },
    { targetType: "announcement", targetId: id, metadata: { active: parsed.data.active } },
  );
  return c.json({ ok: true, id, active: parsed.data.active });
});
