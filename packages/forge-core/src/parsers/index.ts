// @forge/core built-in parsers (08 §M-FORGE-B.1). Register + publish idempotently, mirroring
// registerBuiltinConnectors (ecosystem-facts §A).
import type { ParserRegistry } from "../parserRegistry.ts";
import {
  VOYAGER_PROFILE_ENDPOINT,
  VOYAGER_PROFILE_FINGERPRINT,
  voyagerProfileParserV1,
} from "./voyagerProfile.ts";

export {
  VOYAGER_PROFILE_ENDPOINT,
  VOYAGER_PROFILE_FINGERPRINT,
  voyagerProfileParserV1,
} from "./voyagerProfile.ts";

export function registerBuiltinParsers(registry: ParserRegistry): void {
  registry.addVersion("chrome_extension", VOYAGER_PROFILE_ENDPOINT, {
    id: "voyager-profile-1-0-0",
    version: "1-0-0",
    parser: voyagerProfileParserV1,
    acceptedInputVersions: ["1-0-0"],
    shapeFingerprint: VOYAGER_PROFILE_FINGERPRINT,
  });
  registry.publish("chrome_extension", VOYAGER_PROFILE_ENDPOINT, "voyager-profile-1-0-0");
}
