// bulkStore.ts — the API's FileStore composition for the bulk COPY-staging import (backlog #2, phase 6;
// 15-bulk-import-design §3/§4) AND every other api FileStore consumer (artifact download, reveal export,
// contacts-bulk, admin data-ops — one root store, one selection). GATE B (G07) SELECTION SEAM: when the
// BULK_IMPORT_S3_* env surface is complete the S3-compatible SigV4 adapter (@leadwolf/integrations — no AWS
// SDK) is composed; otherwise the dependency-free local-disk adapter under BULK_IMPORT_STORAGE_DIR — today's
// behavior, byte-identical, so the adapter ships DARK (provisioning the bucket + setting the env vars is the
// entire user-owed enable step). packages/core never imports a concrete store, so the domain layer stays
// cloud-free. Lazily constructed so merely importing the router never touches the filesystem/network.
// The apps/workers consumer composes its OWN store at its composition root via the SAME env selection
// (apps never import apps), so producer writes and consumer reads land on one backend in every env.

import { env } from "@leadwolf/config";
import { type FileStore, diskFileStore } from "@leadwolf/core";
import { s3FileStoreFromEnv } from "@leadwolf/integrations";

let store: FileStore | undefined;

/** The API's bulk-import object store. Env-selected: BULK_IMPORT_S3_* complete ⇒ the S3-compatible adapter
 *  (Gate B / G07); else the DEV/TEST local disk under BULK_IMPORT_STORAGE_DIR — this is the single
 *  composition point to swap (15 §3/§7). */
export function bulkFileStore(): FileStore {
  if (!store) store = s3FileStoreFromEnv() ?? diskFileStore(env.BULK_IMPORT_STORAGE_DIR);
  return store;
}
