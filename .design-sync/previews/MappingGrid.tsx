// MappingGrid - the import column mapper: every canonical field bound to a column from the uploaded file.
//
// The FIELD side is a fixed vocabulary (MAPPABLE_FIELDS, grouped Identity / Person / Company / Location),
// never free text, so a mapping can never point at a key the pipeline does not read. Only the COLUMN side
// comes from the file.
//
// The stories vary the FILE rather than the mapping: the selected option lives in a `<select value>`, so two
// cells over the same headers measure as identical output even though they differ on screen.
import { MappingGrid } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

/** A full eight-column export, fully mapped. */
export const Mapped = () => (
  <Frame>
    <MappingGrid headers={D.CSV_HEADERS} mapping={D.MAPPING} onChange={() => {}} />
  </Frame>
);

/** A three-column file: most canonical fields have nothing to bind to, which the grid has to show rather
 *  than hide - an unmappable field is information, not clutter. */
export const ThinFile = () => (
  <Frame>
    <MappingGrid
      headers={["email", "full_name", "company"]}
      mapping={{ email: "email", accountName: "company" }}
      onChange={() => {}}
    />
  </Frame>
);
