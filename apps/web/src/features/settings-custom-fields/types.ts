// types.ts — view-model types for the Workspace ▸ Custom fields settings slice (ADR-0028, gap G-REV-5).
// Domain shapes (CustomFieldDefinitionDto, CustomFieldType) come from @leadwolf/types; these are the small
// UI-form view-models the panel keeps in local state.

import type { CustomFieldEntity, CustomFieldType } from "@leadwolf/types";

/** The editable surface of the create/edit form (mirrors the create/update request shape, UI-side). */
export interface CustomFieldForm {
  entity: CustomFieldEntity;
  key: string;
  label: string;
  fieldType: CustomFieldType;
  /** Comma/newline-free option labels for a `select` field; ignored for other types. */
  options: string[];
  required: boolean;
}

export const FIELD_TYPE_OPTIONS: { value: CustomFieldType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "select", label: "Select (dropdown)" },
  { value: "boolean", label: "Yes / No" },
  { value: "url", label: "URL" },
];

export const ENTITY_OPTIONS: { value: CustomFieldEntity; label: string }[] = [
  { value: "contact", label: "Contact" },
  { value: "account", label: "Account" },
];

export const EMPTY_FORM: CustomFieldForm = {
  entity: "contact",
  key: "",
  label: "",
  fieldType: "text",
  options: [],
  required: false,
};
