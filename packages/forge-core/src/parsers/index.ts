// @forge/core built-in parsers (08 §M-FORGE-B.1). Register + publish idempotently, mirroring
// registerBuiltinConnectors (ecosystem-facts §A).
import type { ParserRegistry } from "../parserRegistry.ts";
import {
  VOYAGER_PROFILE_ENDPOINT,
  VOYAGER_PROFILE_FINGERPRINT,
  VOYAGER_PROFILE_VERSION_ID,
  voyagerProfileParserV1,
} from "./voyagerProfile.ts";

export {
  VOYAGER_PROFILE_ENDPOINT,
  VOYAGER_PROFILE_FINGERPRINT,
  VOYAGER_PROFILE_PARSER_ID,
  VOYAGER_PROFILE_VERSION_ID,
  voyagerProfileParserV1,
} from "./voyagerProfile.ts";

export function registerBuiltinParsers(registry: ParserRegistry): void {
  // The registry version id IS the seeded forge.parser_versions.id (a uuid), so parsed_records.parser_version_id
  // (the uuid FK) resolves. Keep this uuid in lockstep with 0071_seed_forge_voyager_parser.sql (P-01.1).
  registry.addVersion("chrome_extension", VOYAGER_PROFILE_ENDPOINT, {
    id: VOYAGER_PROFILE_VERSION_ID,
    version: "1-0-0",
    parser: voyagerProfileParserV1,
    acceptedInputVersions: ["1-0-0"],
    shapeFingerprint: VOYAGER_PROFILE_FINGERPRINT,
  });
  registry.publish("chrome_extension", VOYAGER_PROFILE_ENDPOINT, VOYAGER_PROFILE_VERSION_ID);
}
