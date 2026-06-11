// dsarIntake.ts — the public self-serve DSAR intake (08 §4): creates the request with the subject email
// ENCRYPTED + blind-indexed (the find-everywhere key), status `received`. Identity verification (08 §4 —
// the request is acted on only after the requester proves they are the subject) is the staff workflow
// that flips status to `verifying`/`processing`; processing itself runs deleteFanout/assembleAccessReport.

import { dsarRequestRepository } from "@leadwolf/db";
import { blindIndex } from "../import/blindIndex.ts";
import { encryptPii } from "../import/encryptPii.ts";

export async function createDsarRequest(
  requestType: "access" | "delete" | "rectify",
  subjectEmail: string,
): Promise<string> {
  const normalized = subjectEmail.trim().toLowerCase();
  return dsarRequestRepository.create({
    requestType,
    subjectEmailEnc: encryptPii(normalized),
    subjectEmailBlindIndex: blindIndex(normalized),
  });
}
