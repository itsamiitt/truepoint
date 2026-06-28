// bulkStore.ts — the API's FileStore composition for the bulk COPY-staging import (backlog #2, phase 6;
// 15-bulk-import-design §3/§4). DEV/TEST uses the dependency-free local-disk adapter under
// BULK_IMPORT_STORAGE_DIR; the PRODUCTION S3 adapter (presigned multipart + AV-scan-before-promote) is injected
// HERE later (no AWS SDK is pulled into the repo yet) — packages/core never imports a concrete store, so the
// domain layer stays cloud-free. Lazily constructed so merely importing the router never touches the filesystem.
// The apps/workers consumer composes its OWN diskFileStore at its composition root (apps never import apps)
// against the SAME env dir, so the producer's writes and the consumer's reads land on one root in dev.

import { env } from "@leadwolf/config";
import { type FileStore, diskFileStore } from "@leadwolf/core";

let store: FileStore | undefined;

/** The API's bulk-import object store. DEV: local disk under BULK_IMPORT_STORAGE_DIR; PROD: the S3 adapter is
 *  injected here later (15 §3/§7) — this is the single composition point to swap. */
export function bulkFileStore(): FileStore {
  if (!store) store = diskFileStore(env.BULK_IMPORT_STORAGE_DIR);
  return store;
}
