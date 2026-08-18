// inferSeniority.ts — derive the canonical seniority rung (c_suite | vp | director | manager | ic) from a job
// title, for sources that assert a title but no seniority (the linkedin_api landing → the database search's
// seniority facet). Pure, deterministic, conservative: an unrecognized title yields null (never "other"), so a
// filter never matches on a guess. Order of the ladder matters — a "VP of Engineering, Director level" title
// resolves to the most senior rung mentioned, which is what a seniority filter means in practice.
import type { SeniorityLevel } from "@leadwolf/types";

const RULES: ReadonlyArray<[SeniorityLevel, RegExp]> = [
  [
    "c_suite",
    // "president" only when NOT preceded by "vice" — a Vice President is the vp rung below.
    /\b(chief\s+\w+\s+officer|c[a-z]o|ceo|cfo|coo|cto|cio|cmo|cro|cpo|chro|ciso|founder|co-?founder|owner|(?<!vice\s)president|managing\s+partner|general\s+partner|partner)\b/i,
  ],
  ["vp", /\b(vice\s+president|v\.?p\.?|svp|evp|avp|head\s+of)\b/i],
  ["director", /\b(director|principal|distinguished)\b/i],
  ["manager", /\b(manager|lead|supervisor|team\s+lead|scrum\s+master|chief\s+of\s+staff)\b/i],
  [
    "ic",
    /\b(engineer|developer|analyst|specialist|associate|coordinator|representative|consultant|designer|architect|scientist|accountant|recruiter|executive|assistant|intern|administrator|technician|writer|marketer|sdr|bdr|account\s+executive)\b/i,
  ],
];

/** Title → seniority rung, or null when nothing recognizable is present. */
export function inferSeniorityFromTitle(title: string | null | undefined): SeniorityLevel | null {
  if (!title) return null;
  const t = title.trim();
  if (!t) return null;
  for (const [level, re] of RULES) {
    if (re.test(t)) return level;
  }
  return null;
}
