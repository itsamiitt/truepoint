// assistant — the floating support assistant, grounded in this site's own content modules.
//
// The open/closed state and the provider live in components/AssistantContext.tsx, not here: the docs rail
// opens this panel too, and a feature importing a feature is what lint:cross-feature stops.

export { SupportAssistant } from "./components/SupportAssistant.tsx";
export { answerFor, SUGGESTIONS, type Answer } from "./answer.ts";
