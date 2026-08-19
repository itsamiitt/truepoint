// MappingEditor - the field-mapping editor for one CRM connection: which TruePoint field maps to which
// CRM field, and in which direction.
//
// One story: it takes a connectionId and loads its mappings. `connectionId: null` is the not-yet-connected
// state.
import { MappingEditor } from "@leadwolf/ui";
import { Frame } from "./_webPage";

/** A connected HubSpot portal with three mapped fields. */
export const Connected = () => (
  <Frame>
    <MappingEditor connectionId="cx_01" />
  </Frame>
);

/** No connection yet - the editor has nothing to map and says so. */
export const NotConnected = () => (
  <Frame>
    <MappingEditor connectionId={null} />
  </Frame>
);
