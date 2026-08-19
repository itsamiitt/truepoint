// entry.tsx - the design-sync entry for apps/web, the customer app.
//
// Everything below is the app's REAL component, imported from apps/web unmodified. What changes is only what
// sits under them: ./stubs/* replace the token client, Next's router/link/dynamic, and the narrowed
// @leadwolf/types runtime surface at bundle time (see the alias map in manifest.json), so every surface runs
// against ../../prospect/fixtures instead of the network. No component is reimplemented or forked here.
//
// Two halves:
//   1. the PROSPECT slice - the 27 carded components plus the internals they hand off to
//   2. every other feature surface in apps/web, plus the app shell chrome
//
// EXCLUDED ON PURPOSE: apps/web/src/components/PageHeader.tsx. @leadwolf/ui ships the promoted PageHeader
// with the same API (its own header records that it collapses the patterns hand-rolled in apps/admin and
// apps/forge), it is already carded from the primitives, and two exports of one name collide in the
// combined barrel. Route `page.tsx` files are excluded too - each is a thin wrapper around the feature
// component below it.

// -- prospect slice ------------------------------------------------------------------------------------

export { AccountDetailDrawer } from "../../../apps/web/src/features/prospect/components/AccountDetailDrawer";
export { AccountFilterPanel } from "../../../apps/web/src/features/prospect/components/AccountFilterPanel";
export { AccountsTable } from "../../../apps/web/src/features/prospect/components/AccountsTable";
export { AddToListDialog } from "../../../apps/web/src/features/prospect/components/AddToListDialog";
export { AiSearchBox } from "../../../apps/web/src/features/prospect/components/AiSearchBox";
export { BulkActionBar } from "../../../apps/web/src/features/prospect/components/BulkActionBar";
export { BulkRevealDialog } from "../../../apps/web/src/features/prospect/components/BulkRevealDialog";
export { BulkRevealJobDialog } from "../../../apps/web/src/features/prospect/components/BulkRevealJobDialog";
export { CopyButton } from "../../../apps/web/src/features/prospect/components/CopyButton";
export { FacetTypeahead } from "../../../apps/web/src/features/prospect/components/FacetTypeahead";
export { FilterPanel } from "../../../apps/web/src/features/prospect/components/FilterPanel";
export { FilterRail } from "../../../apps/web/src/features/prospect/components/FilterRail";
export { ParsedFilterPreview } from "../../../apps/web/src/features/prospect/components/ParsedFilterPreview";
export { ProspectPage } from "../../../apps/web/src/features/prospect/components/ProspectPage";
export { ProspectToolbar } from "../../../apps/web/src/features/prospect/components/ProspectToolbar";
export { QuickViewDrawer } from "../../../apps/web/src/features/prospect/components/QuickViewDrawer";
export { RecentSearches } from "../../../apps/web/src/features/prospect/components/RecentSearches";
export { RecomputeScoreButton } from "../../../apps/web/src/features/prospect/components/RecomputeScoreButton";
export { RecordDetail } from "../../../apps/web/src/features/prospect/components/RecordDetail";
export { RevealCell } from "../../../apps/web/src/features/prospect/components/RevealCell";
export { RevealDialog } from "../../../apps/web/src/features/prospect/components/RevealDialog";
export { RowActions } from "../../../apps/web/src/features/prospect/components/RowActions";
export { SaveSearchPanel } from "../../../apps/web/src/features/prospect/components/SaveSearchPanel";
export { StageManagementPanel } from "../../../apps/web/src/features/prospect/components/StageManagementPanel";
export { StageSelector } from "../../../apps/web/src/features/prospect/components/StageSelector";
export { TagChip } from "../../../apps/web/src/features/prospect/components/TagChip";
export { TagPicker } from "../../../apps/web/src/features/prospect/components/TagPicker";

// Context plumbing the reveal-aware components read. RevealStoreProvider is carded out via
// componentSrcMap; useRevealStore is camelCase, so it is never a component candidate.
export { RevealStoreProvider, useRevealStore } from "../../../apps/web/src/features/prospect/hooks/useRevealStore";

// The app's REAL client provider stack (TanStack Query). Components that read server state call
// useQueryClient(), which throws without it. Carded out - it is plumbing, not a component anyone designs with.
export { Providers } from "../../../apps/web/src/app/providers";

// -- every other feature surface + the shell chrome ----------------------------------------------------
export { ActivityFeedCard } from "../../../apps/web/src/features/home/components/ActivityFeedCard";
export { AddSendingDomainForm } from "../../../apps/web/src/features/settings-mailboxes/components/AddSendingDomainForm";
export { AnnouncementBanner } from "../../../apps/web/src/features/announcements/AnnouncementBanner";
export { ApiDocsPanel } from "../../../apps/web/src/features/settings-developer/components/ApiDocsPanel";
export { ApiKeysPanel } from "../../../apps/web/src/features/settings-developer/components/ApiKeysPanel";
export { AppShell } from "../../../apps/web/src/components/shell/AppShell";
export { AuthAuditList } from "../../../apps/web/src/features/settings-tenant/components/AuthAuditList";
export { AutoEnrichPanel } from "../../../apps/web/src/features/settings-enrichment/components/AutoEnrichPanel";
export { BarChart } from "../../../apps/web/src/features/reports/charts/BarChart";
export { BillingPage } from "../../../apps/web/src/features/settings-billing/components/BillingPage";
export { BulkImportProgress } from "../../../apps/web/src/features/import/components/BulkImportProgress";
export { BurnSparkline } from "../../../apps/web/src/features/home/components/BurnSparkline";
export { CaptureForm } from "../../../apps/web/src/features/sales-navigator/components/CaptureForm";
export { CompliancePage } from "../../../apps/web/src/features/settings-compliance/components/CompliancePage";
export { ConfirmDialog } from "../../../apps/web/src/features/import/components/shared/ConfirmDialog";
export { ConflictQueue } from "../../../apps/web/src/features/crm-sync/components/ConflictQueue";
export { ConnectMailboxForm } from "../../../apps/web/src/features/settings-mailboxes/components/ConnectMailboxForm";
export { ContactsTable } from "../../../apps/web/src/features/import/components/ContactsTable";
export { CreditPill } from "../../../apps/web/src/components/shell/CreditPill";
export { CreditUsageSection } from "../../../apps/web/src/features/reports/components/CreditUsageSection";
export { CreditsTab } from "../../../apps/web/src/features/settings-billing/components/tabs/CreditsTab";
export { CrmSyncPage } from "../../../apps/web/src/features/crm-sync/components/CrmSyncPage";
export { CustomFieldsPanel } from "../../../apps/web/src/features/settings-custom-fields/components/CustomFieldsPanel";
export { DataHealthCard } from "../../../apps/web/src/features/home/components/DataHealthCard";
export { DataHealthPage } from "../../../apps/web/src/features/data-health/components/DataHealthPage";
export { DataHealthSection } from "../../../apps/web/src/features/reports/components/DataHealthSection";
export { DataHealthTrendCard } from "../../../apps/web/src/features/home/components/DataHealthTrendCard";
export { DeleteListDialog } from "../../../apps/web/src/features/lists/components/DeleteListDialog";
export { DeliverabilitySection } from "../../../apps/web/src/features/reports/components/DeliverabilitySection";
export { DeveloperPage } from "../../../apps/web/src/features/settings-developer/components/DeveloperPage";
export { DistributionChart } from "../../../apps/web/src/features/reports/charts/DistributionChart";
export { DraftReviewPanel } from "../../../apps/web/src/features/sequences/components/DraftReviewPanel";
export { DsarForm } from "../../../apps/web/src/features/settings-compliance/components/DsarForm";
export { DuplicatesSection } from "../../../apps/web/src/features/data-health/components/DuplicatesSection";
export { EnrichmentActivityCard } from "../../../apps/web/src/features/home/components/EnrichmentActivityCard";
export { EnrichmentJobsPage } from "../../../apps/web/src/features/enrichment-jobs/components/EnrichmentJobsPage";
export { EnrollmentLogTable } from "../../../apps/web/src/features/sequences/components/EnrollmentLogTable";
export { EnrollmentPanel } from "../../../apps/web/src/features/sequences/components/EnrollmentPanel";
export { FreshnessTrend } from "../../../apps/web/src/features/data-health/components/FreshnessTrend";
export { FunnelChart } from "../../../apps/web/src/features/reports/charts/FunnelChart";
export { FunnelSection } from "../../../apps/web/src/features/reports/components/FunnelSection";
export { GlobalSearch } from "../../../apps/web/src/components/shell/GlobalSearch";
export { HistoryTab } from "../../../apps/web/src/features/settings-billing/components/tabs/HistoryTab";
export { HomePage } from "../../../apps/web/src/features/home/components/HomePage";
export { HotLeadsCard } from "../../../apps/web/src/features/home/components/HotLeadsCard";
export { IdentityPanel } from "../../../apps/web/src/features/settings-tenant/components/IdentityPanel";
export { ImportDraftFlow } from "../../../apps/web/src/features/import/components/ImportDraftFlow";
export { ImportDraftPreviewPanel } from "../../../apps/web/src/features/import/components/ImportDraftPreviewPanel";
export { ImportDraftsBanner } from "../../../apps/web/src/features/import/components/ImportDraftsBanner";
export { ImportIntoListDialog } from "../../../apps/web/src/features/lists/components/ImportIntoListDialog";
export { ImportJobDrawer } from "../../../apps/web/src/features/import/components/ImportJobDrawer";
export { ImportJobPage } from "../../../apps/web/src/features/import/components/ImportJobPage";
export { ImportJobsHistoryPage } from "../../../apps/web/src/features/import/components/ImportJobsHistoryPage";
export { ImportPage } from "../../../apps/web/src/features/import/components/ImportPage";
export { ImportWizard } from "../../../apps/web/src/features/import/components/ImportWizard";
export { InboxPage } from "../../../apps/web/src/features/inbox/components/InboxPage";
export { IntentSection } from "../../../apps/web/src/features/reports/components/IntentSection";
export { InvoicesTab } from "../../../apps/web/src/features/settings-billing/components/tabs/InvoicesTab";
export { JobDetailDrawer } from "../../../apps/web/src/features/enrichment-jobs/components/JobDetailDrawer";
export { LeadScoreSection } from "../../../apps/web/src/features/reports/components/LeadScoreSection";
export { LineChart } from "../../../apps/web/src/features/reports/charts/LineChart";
export { LinksTable } from "../../../apps/web/src/features/sales-navigator/components/LinksTable";
export { ListDetailPage } from "../../../apps/web/src/features/lists/components/ListDetailPage";
export { ListFormDialog } from "../../../apps/web/src/features/lists/components/ListFormDialog";
export { ListsPage } from "../../../apps/web/src/features/lists/components/ListsPage";
export { MailboxList } from "../../../apps/web/src/features/settings-mailboxes/components/MailboxList";
export { MailboxesPage } from "../../../apps/web/src/features/settings-mailboxes/components/MailboxesPage";
export { MappingEditor } from "../../../apps/web/src/features/crm-sync/components/MappingEditor";
export { MappingGrid } from "../../../apps/web/src/features/import/components/MappingGrid";
export { MembersPanel } from "../../../apps/web/src/features/settings-workspace/components/MembersPanel";
export { MergeReviewDrawer } from "../../../apps/web/src/features/data-health/components/MergeReviewDrawer";
export { MetricsSection } from "../../../apps/web/src/features/data-health/components/MetricsSection";
export { NotificationsBell } from "../../../apps/web/src/components/shell/NotificationsBell";
export { NotificationsPage } from "../../../apps/web/src/features/notifications/components/NotificationsPage";
export { NotificationsPanel } from "../../../apps/web/src/features/settings-user/components/NotificationsPanel";
export { OAuthAppsPanel } from "../../../apps/web/src/features/settings-developer/components/OAuthAppsPanel";
export { OrgSwitcher } from "../../../apps/web/src/components/shell/OrgSwitcher";
export { OrganizationPanel } from "../../../apps/web/src/features/settings-tenant/components/OrganizationPanel";
export { PerFieldFill } from "../../../apps/web/src/features/data-health/components/PerFieldFill";
export { PlanTab } from "../../../apps/web/src/features/settings-billing/components/tabs/PlanTab";
export { ProfilePanel } from "../../../apps/web/src/features/settings-user/components/ProfilePanel";
export { ProviderPriorityPanel } from "../../../apps/web/src/features/settings-enrichment/components/ProviderPriorityPanel";
export { PublicPricingPage } from "../../../apps/web/src/features/public-pricing/components/PublicPricingPage";
export { QuickActionsRow } from "../../../apps/web/src/features/home/components/QuickActionsRow";
export { RecentImportsCard } from "../../../apps/web/src/features/home/components/RecentImportsCard";
export { RecentRevealsCard } from "../../../apps/web/src/features/home/components/RecentRevealsCard";
export { RepliesCard } from "../../../apps/web/src/features/home/components/RepliesCard";
export { ReportsPage } from "../../../apps/web/src/features/reports/components/ReportsPage";
export { RetentionActivity } from "../../../apps/web/src/features/data-health/components/RetentionActivity";
export { ReverificationActivity } from "../../../apps/web/src/features/data-health/components/ReverificationActivity";
export { ReverifyNowButton } from "../../../apps/web/src/features/data-health/components/ReverifyNowButton";
export { SalesNavPage } from "../../../apps/web/src/features/sales-navigator/components/SalesNavPage";
export { SectionCard } from "../../../apps/web/src/features/data-health/components/SectionCard";
export { SecurityAccessPanel } from "../../../apps/web/src/features/settings-tenant/components/SecurityAccessPanel";
export { SecurityPanel } from "../../../apps/web/src/features/settings-user/components/SecurityPanel";
export { SendStatusDashboard } from "../../../apps/web/src/features/sequences/components/SendStatusDashboard";
export { SendingDomainList } from "../../../apps/web/src/features/settings-mailboxes/components/SendingDomainList";
export { SequenceBuilder } from "../../../apps/web/src/features/sequences/components/SequenceBuilder";
export { SequenceList } from "../../../apps/web/src/features/sequences/components/SequenceList";
export { SequenceSnapshot } from "../../../apps/web/src/features/home/components/SequenceSnapshot";
export { SequencesPage } from "../../../apps/web/src/features/sequences/components/SequencesPage";
export { SessionsPanel } from "../../../apps/web/src/features/settings-workspace/components/SessionsPanel";
export { SettingsNav } from "../../../apps/web/src/features/settings-shell/components/SettingsNav";
export { SettingsPlaceholder } from "../../../apps/web/src/features/settings-shell/components/SettingsPlaceholder";
export { SettingsScopeLayout } from "../../../apps/web/src/features/settings-shell/components/SettingsScopeLayout";
export { SourceCoverageSection } from "../../../apps/web/src/features/data-health/components/SourceCoverageSection";
export { SsoConfigPanel } from "../../../apps/web/src/features/settings-tenant/components/SsoConfigPanel";
export { SubscriptionTab } from "../../../apps/web/src/features/settings-billing/components/tabs/SubscriptionTab";
export { SuppressionForm } from "../../../apps/web/src/features/settings-compliance/components/SuppressionForm";
export { SuppressionList } from "../../../apps/web/src/features/settings-compliance/components/SuppressionList";
export { SyncActivity } from "../../../apps/web/src/features/crm-sync/components/SyncActivity";
export { TasksCard } from "../../../apps/web/src/features/home/components/TasksCard";
export { TasksPanel } from "../../../apps/web/src/features/inbox/components/TasksPanel";
export { TeamActivitySection } from "../../../apps/web/src/features/reports/components/TeamActivitySection";
export { TeamSwitcher } from "../../../apps/web/src/components/shell/TeamSwitcher";
export { TeamsPanel } from "../../../apps/web/src/features/settings-teams/components/TeamsPanel";
export { TemplateControls } from "../../../apps/web/src/features/import/components/TemplateControls";
export { TemplateEditor } from "../../../apps/web/src/features/sequences/components/TemplateEditor";
export { TemplatesPanel } from "../../../apps/web/src/features/sequences/components/TemplatesPanel";
export { ThreadList } from "../../../apps/web/src/features/inbox/components/ThreadList";
export { ThreadView } from "../../../apps/web/src/features/inbox/components/ThreadView";
export { UsageTab } from "../../../apps/web/src/features/settings-billing/components/tabs/UsageTab";
export { UsageTable } from "../../../apps/web/src/features/settings-billing/components/UsageTable";
export { VerificationBreakdown } from "../../../apps/web/src/features/data-health/components/VerificationBreakdown";
export { VersionHistoryDrawer } from "../../../apps/web/src/features/sequences/components/VersionHistoryDrawer";
export { WebhooksPanel } from "../../../apps/web/src/features/settings-developer/components/WebhooksPanel";
export { WidgetCard } from "../../../apps/web/src/features/home/components/WidgetCard";
export { WorkspaceGeneralPanel } from "../../../apps/web/src/features/settings-workspace/components/WorkspaceGeneralPanel";
export { WorkspaceSwitcher } from "../../../apps/web/src/components/shell/WorkspaceSwitcher";
