-- 0139_contact_master_presence.sql — Layer-0 channel PRESENCE persisted on the workspace copy (reveal-as-save,
-- decisions.md 2026-08-25) [S-04][S-10]
-- HAND-AUTHORED, additive-only. No drizzle-kit generate — the snapshot chain stopped at 0107 (see 0137).
--
-- WHY. A contact materialized from the TruePoint database carries NO channel value until it is revealed — the
-- values are the paid product, copied onto the contact by the reveal one channel at a time. The workspace
-- search projection derives hasEmail/hasPhone from `email_enc IS NOT NULL` / `phone_enc IS NOT NULL`, so
-- after a rep reveals a person's EMAIL the Phone cell reads "—" on the next refetch even when the platform
-- holds a licensed phone for them. "No phone" would be a false claim about the world, and the reveal-as-save
-- gesture would have no button left to press. leadwolf_app is REVOKEd from master_* (the role wall), so the
-- projection cannot look the presence up at query time; the landing writes it here instead, and the
-- projection ORs it in: hasEmail = email_enc IS NOT NULL OR coalesce(master_has_email, false).
--
-- BOOLEANS, NEVER VALUES. These say only "the platform holds one" — exactly what the database search already
-- says of the same person; no address or number moves, so the monetization boundary is untouched.
--
-- NULL MEANS UNKNOWN, NEVER "NO". Written by landOverlayPerson from the master row whenever a person is
-- (re)materialized. There is NO backfill here, deliberately: contacts is FORCE-RLS with a fail-closed GUC, so a
-- migration-time UPDATE would silently touch zero rows on any owner without BYPASSRLS (Neon), and behave
-- differently on the superuser Testcontainers run — an environment-dependent migration is worse than a NULL.
-- Contacts bridged before this migration keep the flat behaviour they had (NULL folds to false); every
-- contact saved through the reveal gesture from now on carries the bits. A person who gains a channel in
-- Layer 0 later is refreshed on their next landing, not by a sweep: a stale TRUE degrades to the reveal's
-- honest "no <channel> on file — nothing was charged"; a stale FALSE is the pre-existing "—".
--
-- EXPAND ONLY. Nullable, no default: a catalog-only ALTER on Postgres 11+ (brief ACCESS EXCLUSIVE, no
-- rewrite). Rollback is to stop reading the columns, never to DROP them.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS master_has_email boolean,
  ADD COLUMN IF NOT EXISTS master_has_phone boolean;
