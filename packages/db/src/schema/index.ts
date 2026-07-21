// Aggregates all Drizzle table definitions for the client + drizzle-kit. Add new schema files here.
export * from "./auth.ts";
export * from "./contacts.ts";
export * from "./contactChannels.ts";
export * from "./accountChildren.ts";
export * from "./masterGraph.ts";
export * from "./processedSyncEvents.ts";
// NOTE: ./forge.ts is intentionally NOT re-exported here — its tables live in the `forge` Postgres schema and
// several Drizzle identifiers (matchLinks, approvalRequests, reviewTasks, parsers…) collide with the public
// ones. The forge repos import ../schema/forge.ts directly (insert/select take the table object), and the db
// index re-exports the forge tables under a `forge` namespace for external consumers.
export * from "./customFields.ts";
export * from "./tags.ts";
export * from "./billing.ts";
export * from "./intel.ts";
export * from "./compliance.ts";
export * from "./activity.ts";
export * from "./salesnav.ts";
export * from "./outreach.ts";
export * from "./email.ts";
export * from "./enrichmentJobs.ts";
export * from "./revealJobs.ts";
export * from "./eventOutbox.ts";
export * from "./importJobs.ts";
export * from "./pipelineStages.ts";
export * from "./savedSearches.ts";
export * from "./lists.ts";
export * from "./enrichmentPolicy.ts";
export * from "./importPolicy.ts";
export * from "./scheduledImports.ts";
export * from "./webhooks.ts";
export * from "./importMappingTemplates.ts";
export * from "./featureFlags.ts";
export * from "./scim.ts";
export * from "./platformOps.ts";
export * from "./verificationJobs.ts";
export * from "./dataQualitySnapshots.ts";
export * from "./retention.ts";
export * from "./validationRules.ts";
export * from "./projectionOutbox.ts";
export * from "./workerOutbox.ts";
export * from "./notifications.ts";
export * from "./aiRequests.ts";
export * from "./subscriptions.ts";
export * from "./teams.ts";
