// ParsedFilterPreview — the human-in-the-loop confirmation step for AI search (23, ADR-0023). The model
// never applies a filter directly: it compiles natural language to a VALIDATED contactQuery, and this
// renders that query in plain language so the user can confirm or discard it.
import { ParsedFilterPreview } from "@leadwolf/ui";
import { AI_SEARCH_RESPONSE } from "../prospect/fixtures";
import { Shell, pad } from "./_prospectShell";

/** A compiled query with four clauses plus the model's note about what it had to drop. */
export const Compiled = () => (
  <Shell>
    <div style={pad}>
      <ParsedFilterPreview result={AI_SEARCH_RESPONSE as never} />
    </div>
  </Shell>
);

/** A narrower parse with no caveats — no note line, so the card is the clause list alone. */
export const NoNotes = () => (
  <Shell>
    <div style={pad}>
      <ParsedFilterPreview
        result={
          {
            query: {
              text: "",
              sort: "relevance",
              limit: 50,
              filters: [
                { kind: "term", field: "company", op: "include", values: ["Datadog", "Snowflake"] },
                { kind: "term", field: "outreach_status", op: "exclude", values: ["unsubscribed"] },
              ],
            },
            usedRepair: false,
          } as never
        }
      />
    </div>
  </Shell>
);
