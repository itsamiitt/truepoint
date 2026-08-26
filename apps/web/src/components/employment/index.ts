// components/employment — the grouped (company-block) employment history, shared by the owned-contact
// record drawer and the global Layer-0 profile drawer. Pure props; imports nothing from features/, so it
// cannot close an import cycle between the two slices that render it.
export { EmploymentHistory } from "./EmploymentHistory";
