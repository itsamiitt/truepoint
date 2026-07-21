// forgeObjectStore — the REAL object-store adapter (Phase 4) implementing @leadwolf/forge-core's ObjectStore
// (put) + BlobFetcher (fetch) against S3/MinIO via Bun's native S3 client. Large raw payloads offload here
// (SSE-KMS in prod); the API writes them at land, the parse worker reads them back — the SAME bucket bridges
// the two processes. Small payloads stay inline and never touch this. Re-homed from @forge/adapters.
import type { BlobFetcher, ObjectStore } from "@leadwolf/forge-core";

export interface ForgeS3Config {
  bucket: string;
  endpoint?: string; // set for MinIO / non-AWS
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
}

export function forgeObjectStore(cfg: ForgeS3Config): ObjectStore & BlobFetcher {
  const client = new Bun.S3Client({
    bucket: cfg.bucket,
    endpoint: cfg.endpoint,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
  });
  return {
    async put(key: string, bytes: string): Promise<string> {
      await client.write(key, bytes);
      return key; // the pointer stored in raw_captures.payload_ref
    },
    async fetch(ref: string): Promise<string> {
      return client.file(ref).text();
    },
  };
}
