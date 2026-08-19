// entry.tsx — the design-sync entry for apps/admin, the internal staff console.
//
// Everything below is the app's REAL component, imported from apps/admin unmodified. Only the token client
// and Next's router are swapped for stubs at bundle time (see the alias map in manifest.json), so the
// console runs against fixtured /api/v1/admin routes instead of the api. The staff gates (adminGate,
// StaffMeProvider) are NOT stubbed — they probe routes the stub answers, so their real classification code
// runs and lands on the authorized branch.
//
// Scope: every feature component, the shared pickers/banner, and the shell. The route `page.tsx` files are
// excluded — each is a thin wrapper that renders the feature component below it.

export { EntityPicker } from "../../../apps/admin/src/components/EntityPicker";
export { ImpersonationBanner } from "../../../apps/admin/src/components/ImpersonationBanner";
export { TenantPicker } from "../../../apps/admin/src/components/TenantPicker";
export { UserPicker } from "../../../apps/admin/src/components/UserPicker";
export { AdminShell } from "../../../apps/admin/src/components/shell/AdminShell";
export { AiUsagePage } from "../../../apps/admin/src/features/ai-usage/components/AiUsagePage";
export { AuditLogPage } from "../../../apps/admin/src/features/audit-log/components/AuditLogPage";
export { AuthPolicyPage } from "../../../apps/admin/src/features/auth-policy/components/AuthPolicyPage";
export { EditDefaultDialog } from "../../../apps/admin/src/features/auth-policy/components/EditDefaultDialog";
export { BillingEconomicsPage } from "../../../apps/admin/src/features/billing/components/BillingEconomicsPage";
export { EconomicsTrend } from "../../../apps/admin/src/features/billing/components/EconomicsTrend";
export { CompliancePage } from "../../../apps/admin/src/features/compliance/components/CompliancePage";
export { GlobalSuppression } from "../../../apps/admin/src/features/compliance/components/GlobalSuppression";
export { RetentionPolicies } from "../../../apps/admin/src/features/compliance/components/RetentionPolicies";
export { SubProcessors } from "../../../apps/admin/src/features/compliance/components/SubProcessors";
export { ContentPage } from "../../../apps/admin/src/features/content/components/ContentPage";
export { CrmSyncMonitorPage } from "../../../apps/admin/src/features/crm-sync/components/CrmSyncMonitorPage";
export { DeadLetterQueue } from "../../../apps/admin/src/features/crm-sync/components/DeadLetterQueue";
export { ApprovalsPage } from "../../../apps/admin/src/features/data-ops/components/ApprovalsPage";
export { DataImportDetailPage } from "../../../apps/admin/src/features/data-ops/components/DataImportDetailPage";
export { DataOpsOverviewPage } from "../../../apps/admin/src/features/data-ops/components/DataOpsOverviewPage";
export { DedupReviewPage } from "../../../apps/admin/src/features/data-ops/components/DedupReviewPage";
export { EnrichmentRunsPage } from "../../../apps/admin/src/features/data-ops/components/EnrichmentRunsPage";
export { FleetQualityPage } from "../../../apps/admin/src/features/data-ops/components/FleetQualityPage";
export { RuleFormDialog } from "../../../apps/admin/src/features/data-ops/components/RuleFormDialog";
export { ValidationRulesPage } from "../../../apps/admin/src/features/data-ops/components/ValidationRulesPage";
export { VerificationRunsPage } from "../../../apps/admin/src/features/data-ops/components/VerificationRunsPage";
export { DataQualityPage } from "../../../apps/admin/src/features/data-quality/components/DataQualityPage";
export { DataSourceOriginsPage } from "../../../apps/admin/src/features/data-sources/components/DataSourceOriginsPage";
export { ExtensionPage } from "../../../apps/admin/src/features/extension/components/ExtensionPage";
export { EnvGatesPanel } from "../../../apps/admin/src/features/feature-flags/components/EnvGatesPanel";
export { FeatureFlagsPage } from "../../../apps/admin/src/features/feature-flags/components/FeatureFlagsPage";
export { NewFlagDialog } from "../../../apps/admin/src/features/feature-flags/components/NewFlagDialog";
export { OverrideDialog } from "../../../apps/admin/src/features/feature-flags/components/OverrideDialog";
export { ImportsMonitorPage } from "../../../apps/admin/src/features/imports/components/ImportsMonitorPage";
export { PlansPage } from "../../../apps/admin/src/features/plans/components/PlansPage";
export { PricingPage } from "../../../apps/admin/src/features/pricing/components/PricingPage";
export { ProviderConfigsPage } from "../../../apps/admin/src/features/provider-configs/components/ProviderConfigsPage";
export { EditPolicyDialog } from "../../../apps/admin/src/features/retention/components/EditPolicyDialog";
export { RetentionPage } from "../../../apps/admin/src/features/retention/components/RetentionPage";
export { RetentionPoliciesPage } from "../../../apps/admin/src/features/retention/components/RetentionPoliciesPage";
export { RetentionRunsPanel } from "../../../apps/admin/src/features/retention/components/RetentionRunsPanel";
export { StaffPage } from "../../../apps/admin/src/features/staff/components/StaffPage";
export { SystemHealthPage } from "../../../apps/admin/src/features/system-health/components/SystemHealthPage";
export { AuthEnforcementCard } from "../../../apps/admin/src/features/tenants/components/AuthEnforcementCard";
export { SupportNotes } from "../../../apps/admin/src/features/tenants/components/SupportNotes";
export { TenantActions } from "../../../apps/admin/src/features/tenants/components/TenantActions";
export { TenantDetailPage } from "../../../apps/admin/src/features/tenants/components/TenantDetailPage";
export { TenantEconomics } from "../../../apps/admin/src/features/tenants/components/TenantEconomics";
export { TenantHolds } from "../../../apps/admin/src/features/tenants/components/TenantHolds";
export { TenantLedger } from "../../../apps/admin/src/features/tenants/components/TenantLedger";
export { TenantMoneyApprovals } from "../../../apps/admin/src/features/tenants/components/TenantMoneyApprovals";
export { TenantOverview } from "../../../apps/admin/src/features/tenants/components/TenantOverview";
export { TenantPurchases } from "../../../apps/admin/src/features/tenants/components/TenantPurchases";
export { TenantSubscription } from "../../../apps/admin/src/features/tenants/components/TenantSubscription";
export { TenantsPage } from "../../../apps/admin/src/features/tenants/components/TenantsPage";
export { TrustAbusePage } from "../../../apps/admin/src/features/trust-abuse/components/TrustAbusePage";
export { UsersPage } from "../../../apps/admin/src/features/users/components/UsersPage";
