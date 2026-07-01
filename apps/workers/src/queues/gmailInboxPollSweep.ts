// gmailInboxPollSweep.ts — the leader-locked M12 P3 inbound-reply poller (DARK behind EMAIL_INBOX_ENABLED). Per
// connected Google mailbox: resolve a FRESH access token (decrypt+refresh, tenant-scoped), list Gmail history
// since the stored cursor, fetch + parse each new message, ENCRYPT the body (D7 — plaintext never reaches the
// recorder), and hand it to recordInboundReply (thread-match → record inbound → auto-pause a HUMAN reply). A
// mailbox with no cursor yet is SEEDED from its current historyId (no historical backfill). A reauth failure
// flags the mailbox for the "Reconnect" UX. One mailbox failing never blocks the rest.

import {
  GmailReadError,
  encryptSecret,
  fetchGmailReadPort,
  fetchInboundSince,
  fetchProfileHistoryId,
  getMailboxAccessToken,
  recordInboundReply,
} from "@leadwolf/core";
import { mailboxRepository, withTenantTx } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const GMAIL_INBOX_POLL_QUEUE = "gmail_inbox_poll";
const LEADER_KEY = "leader:gmail_inbox_poll";
const LEADER_TTL_MS = 10 * 60_000;
const MAX_MAILBOXES = 200;

export type GmailInboxPollJobData = Record<string, never>;

/** Build the sweep processor. Leader-locked; iterates the connected-Google worklist (owner path) and polls each
 *  mailbox's inbox under its own tenant-scoped tx. */
export function makeProcessGmailInboxPoll(redis: IORedis) {
  return async function processGmailInboxPoll(_job: Job<GmailInboxPollJobData>): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const mailboxes = await mailboxRepository.listConnectedGoogleForPoll(MAX_MAILBOXES);
      const port = fetchGmailReadPort;
      let recorded = 0;
      let reauth = 0;
      let failures = 0;

      for (const mb of mailboxes) {
        const scope = { tenantId: mb.tenantId, workspaceId: mb.workspaceId };
        try {
          const token = await getMailboxAccessToken(scope, mb.id);
          // Seed the cursor on the first poll — a baseline only, no historical backfill.
          if (!mb.gmailHistoryId) {
            const hid = await fetchProfileHistoryId(port, token);
            if (hid) {
              await withTenantTx(scope, (tx) =>
                mailboxRepository.updateGmailHistoryId(tx, mb.id, hid),
              );
            }
            continue;
          }
          const { messages, newHistoryId } = await fetchInboundSince(
            port,
            token,
            mb.gmailHistoryId,
          );
          for (const m of messages) {
            const { bodyText, ...rest } = m;
            const bodyEnc = bodyText ? encryptSecret(bodyText) : null;
            await withTenantTx(scope, (tx) =>
              recordInboundReply(
                tx,
                { ...scope, mailboxIntegrationId: mb.id },
                { ...rest, bodyEnc },
              ),
            );
            recorded += 1;
          }
          if (newHistoryId) {
            await withTenantTx(scope, (tx) =>
              mailboxRepository.updateGmailHistoryId(tx, mb.id, newHistoryId),
            );
          }
        } catch (err) {
          if (err instanceof GmailReadError && err.reauth) {
            reauth += 1;
            await withTenantTx(scope, (tx) =>
              mailboxRepository.markReauthRequired(tx, mb.id, "inbound_poll_unauthorized"),
            ).catch(() => {});
            continue;
          }
          failures += 1;
          log.error("gmail-inbox-poll: mailbox failed", {
            mailboxId: mb.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      log.info("gmail-inbox-poll sweep", {
        mailboxes: mailboxes.length,
        recorded,
        reauth,
        failures,
      });
    });
  };
}
