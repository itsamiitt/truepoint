// EditDefaultDialog - edit one platform-default auth policy key. Platform defaults are the floor every org
// inherits and can only tighten, so this dialog changes the baseline for the whole fleet.
import { EditDefaultDialog } from "@leadwolf/ui";
import { Stage } from "./_appPage";

/** The dialog open over its stage, as staff reach it from the auth-policy table. */
export const Open = () => (
  <Stage height={480}>
    <EditDefaultDialog onClose={() => {}} onSaved={() => {}} />
  </Stage>
);
