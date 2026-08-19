// Aggregates all Drizzle table definitions for the client + drizzle-kit. Add new schema files here.
export * from "./auth.ts";
export * from "./contacts.ts";
export * from "./contactChannels.ts";
export * from "./accountChildren.ts";
export * from "./masterGraph.ts";
export * from "./masterTechnology.ts";
export * from "./masterCompanyDetail.ts";
// Layer-0 multi-value person attributes (0116): skills + languages. In the barrel on purpose — plain
// tables, so drizzle-kit generates their migration WITH a snapshot (ratchet-neutral).
export * from "./masterPersonAttributes.ts";
// Data-source origin fleet (0117): per-provider failover chain of interchangeable origins. Holds
// encrypted per-origin API keys — leadwolf_app is REVOKEd entirely (see applyMigrations).
export * from "./providerOrigins.ts";
// URL fetch registry (0118): one row per canonical LinkedIn/Sales-Nav URL with a real last_fetched_at —
// the 30-day freshness clock. Platform-global, app-REVOKEd (see applyMigrations).
export * from "./sourceFetchRegistry.ts";
export * from "./masterConfidencePolicy.ts";
export * from "./masterIndustries.ts";
export * from "./processedSyncEvents.ts";
// NOTE: ./forge.ts is intentionally NOT re-exported here — its tables live in the `forge` Postgres schema and
// several Drizzle identifiers (matchLinks, approvalRequests, reviewTasks, parsers…) collide with the public
// ones. The forge repos import ../schema/forge.ts directly (insert/select take the table object), and the db
// index re-exports the forge tables under a `forge` namespace for external consumers.
export * from "./customFields.ts";
export * from "./tags.ts";
export * from "./billing.ts";
export * from "./intel.ts";
export * from "./tenantSignals.ts";
export * from "./watchlists.ts";
export * from "./accountScores.ts";
export * from "./compliance.ts";
export * from "./activity.ts";
export * from "./salesnav.ts";
export * from "./outreach.ts";
export * from "./email.ts";
export * from "./crm.ts";
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
