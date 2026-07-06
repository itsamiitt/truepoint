// channelDualWrite.ts — the S-CH2 dual-gate evaluator + the phone channel-value builder
// (import-and-data-model-redesign 05 §4/§Implementation Steps; T-CH parity is the gate-off proof).
//
// THE GATE (dual, fail-closed — the importV2Gate.ts precedent): effective dual-write =
//   env.CHANNEL_DUAL_WRITE (global kill-switch, explicit-"true"-only — the name doc 05 pins)
//   AND the per-tenant `channels_dual_write` feature flag (seeded off in 0059).
// While the ENV layer is off this performs ZERO queries, so a gate-off write is cost-identical as well as
// byte-identical. The flag layer is evaluated IN-TX (works identically in apps/api and apps/workers — both
// reach writers through withTenantTx; there is no job-payload carry, so a mid-run flag flip takes effect on
// the next evaluation). Unknown/unreadable flag ⇒ off (fail-closed via evaluateFlag). 05 §5 does not pin
// where the worker evaluates; the in-tx choice is recorded as a doc-16 drift row.
//
// THE BUILDER (05 §4, DM1 — zero new normalizers): reuses core's shipped `toE164` (libphonenumber-js) +
// `blindIndex` + `encryptPii` verbatim. Dual representation: `value_enc` = the cleaned as-entered value's
// ciphertext (the caller passes the EXACT bytes it wrote to contacts.phone_enc so the primary child row is
// byte-identical to the flat cache — CH-INV-1); `blind_index` = HMAC of the digit-compacted raw ([\s().-]
// stripped, leading + kept) — the exact-value key that works even when E.164 parsing fails; `e164_*` NULL
// exactly when unparseable (kept + flagged upstream, never rejected). `country_hint` records the hint
// ACTUALLY used so a re-parse is reproducible.

import { env } from "@leadwolf/config";
import { type PhoneChannelValue, type Tx, withTenantTx } from "@leadwolf/db";
import { CHANNELS_DUAL_WRITE_FLAG_KEY } from "@leadwolf/types";
import type { CountryCode } from "libphonenumber-js";
import { toE164 } from "../enrichment/matchKeys.ts";
import { isFlagEnabledForTenant } from "../featureFlags/flagsForTenant.ts";
import { blindIndex } from "../import/blindIndex.ts";
import { encryptPii } from "../import/encryptPii.ts";
import { normalizeText } from "../import/normalize.ts";

/** Evaluate the S-CH2 dual gate INSIDE an existing tenant tx (enrich/reveal/re-verify writers). Env layer
 *  off ⇒ false with zero queries. A flag-read failure propagates with the caller's tx (the two PK lookups
 *  share the transaction's fate — never catch inside an aborted tx). */
export async function isChannelDualWriteEnabled(tx: Tx, tenantId: string): Promise<boolean> {
  if (!env.CHANNEL_DUAL_WRITE) return false;
  return isFlagEnabledForTenant(tx, tenantId, CHANNELS_DUAL_WRITE_FLAG_KEY);
}

/** Evaluate the dual gate ONCE per run in its own scoped tx (the import engine's per-run evaluation — a
 *  10k-row import must not re-read the flag per row). FAIL-CLOSED on error: a flag-read hiccup falls back
 *  to the shipped flat-only path (dual-write is additive; the S-CH3 backfill + S-CH5 sweep close any tail),
 *  never fails the run. */
export async function channelDualWriteEnabledForScope(scope: {
  tenantId: string;
  workspaceId: string;
}): Promise<boolean> {
  if (!env.CHANNEL_DUAL_WRITE) return false;
  try {
    return await withTenantTx(scope, (tx) =>
      isFlagEnabledForTenant(tx, scope.tenantId, CHANNELS_DUAL_WRITE_FLAG_KEY),
    );
  } catch (err) {
    console.error("[channels] dual-write flag read failed; falling back to flat-only", err);
    return false;
  }
}

/** The 05 §1.1 phone blind-index form: digit-compacted raw — `[\s().-]` stripped, leading `+` kept. NOT a
 *  new normalizer of an existing form (DM1): it is the per-table index form 05 specifies for phones. */
export function phoneRawIndexForm(cleaned: string): string {
  return cleaned.replace(/[\s().-]/g, "");
}

/** Country-hint resolution, S-CH2 slice of the 05 §4.2 order: per-import wizard option and workspace default
 *  do not exist yet (S-I8/doc 08 own them), so the row's mapped locationCountry is used WHEN it is already an
 *  ISO-3166 alpha-2 code — free-text country names are NOT guessed at ("United States" ⇒ no hint; only
 *  `+`-prefixed international numbers parse). Recorded on the row via `country_hint` when used. */
export function countryHintOf(locationCountry: string | null | undefined): CountryCode | undefined {
  const v = normalizeText(locationCountry);
  if (!v || !/^[A-Za-z]{2}$/.test(v)) return undefined;
  return v.toUpperCase() as CountryCode;
}

export interface BuildPhoneChannelInput {
  /** The cleaned as-entered value (normalizeText output) — the SAME plaintext the caller encrypted flat. */
  cleaned: string;
  /** The EXACT ciphertext bytes the caller wrote to contacts.phone_enc (CH-INV-1 byte identity). */
  phoneEnc: Uint8Array;
  /** ISO-3166 alpha-2 default region for national-format numbers (countryHintOf / caller-known). */
  countryHint?: CountryCode;
}

/** Build the byte payload for a `phone_upsert` op (05 §4 write-time pipeline). Pure crypto/derivation — no
 *  IO; the unparseable case yields NULL e164 material (the value is kept, flagged upstream, never fatal).
 *  `extension` stays NULL in S-CH2 (the shipped `toE164` exposes no `ext`; an explicit import column lands
 *  with doc 08's channel mapping slots — doc-16 drift row). */
export function buildPhoneChannelValue(
  input: BuildPhoneChannelInput,
): Omit<PhoneChannelValue, "source" | "sourceImportId" | "type"> {
  const e164 = toE164(input.cleaned, input.countryHint);
  return {
    valueEnc: input.phoneEnc,
    blindIndex: blindIndex(phoneRawIndexForm(input.cleaned)),
    e164Enc: e164 ? encryptPii(e164) : null,
    e164BlindIndex: e164 ? blindIndex(e164) : null,
    // value_enc already IS the cleaned form; the byte-exact raw original is only stored when it differs —
    // the import pipeline's cell text equals the cleaned form after normalizeText, so NULL here.
    rawOriginalEnc: null,
    countryHint: input.countryHint ?? null, // the hint USED at parse time (even when parsing failed)
    lineType: null,
    lineTypeSource: null,
  };
}
