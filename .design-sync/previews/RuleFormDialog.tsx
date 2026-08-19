// RuleFormDialog - the import validation rule builder. `rule: null` means create; a rule means edit.
//
// The field picker is bound to the canonical contact fields the import pipeline maps to, so a rule can
// never be written against a key that never fires.
import { RuleFormDialog } from "@leadwolf/ui";
import { CUSTOM_RULE } from "./_adminFixtures";
import { Stage } from "./_appPage";

/** Create - the empty form the New rule button opens. */
export const Create = () => (
  <Stage height={560}>
    <RuleFormDialog rule={null} onClose={() => {}} onSaved={() => {}} />
  </Stage>
);

/** Edit an existing regex rule. The config shape changes with the check type, which is the variant axis. */
export const EditRegex = () => (
  <Stage height={560}>
    <RuleFormDialog rule={CUSTOM_RULE} onClose={() => {}} onSaved={() => {}} />
  </Stage>
);

/** A max-length rule, whose config is a number rather than a pattern. */
export const EditMaxLength = () => (
  <Stage height={560}>
    <RuleFormDialog
      rule={{
        ...CUSTOM_RULE,
        id: "00000000-0000-4000-8000-00000000c001",
        name: "Job title under 120 characters",
        field: "jobTitle",
        checkType: "max_length",
        config: { max: 120 },
      }}
      onClose={() => {}}
      onSaved={() => {}}
    />
  </Stage>
);
