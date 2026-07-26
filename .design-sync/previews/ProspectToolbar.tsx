// ProspectToolbar — the results header: the match count, the sort control, and the column chooser. Sort is
// part of the query (so it round-trips through the URL); visible columns are local view state.
import { ProspectToolbar } from "@leadwolf/ui";
import { useState } from "react";
import { COLUMNS, CONTACT_QUERY, VISIBLE_COLUMNS } from "../prospect/fixtures";
import { Shell, pad, useOpenMenu } from "./_prospectShell";

/** Default relevance sort with the four core columns shown. */
export const Default = () => {
  const [query, setQuery] = useState(CONTACT_QUERY);
  const [cols, setCols] = useState(VISIBLE_COLUMNS);
  return (
    <Shell>
      <div style={pad}>
        <ProspectToolbar
          query={query}
          onChange={setQuery}
          columns={COLUMNS}
          visibleColumns={cols}
          onVisibleColumnsChange={setCols}
        />
      </div>
    </Shell>
  );
};

/** Sorted by score, with the column chooser forced open — the toolbar's real substance is that menu, and
 *  its open state lives inside the DropdownMenu, reachable only through the trigger. */
export const ColumnChooser = () => {
  const [query, setQuery] = useState({ ...CONTACT_QUERY, sort: "score_desc" as const });
  const [cols, setCols] = useState([...VISIBLE_COLUMNS, "seniority", "location", "status"]);
  const ref = useOpenMenu<HTMLDivElement>();
  return (
    <Shell>
      <div ref={ref} style={{ ...pad, paddingBottom: 260 }}>
        <ProspectToolbar
          query={query}
          onChange={setQuery}
          columns={COLUMNS}
          visibleColumns={cols}
          onVisibleColumnsChange={setCols}
        />
      </div>
    </Shell>
  );
};
