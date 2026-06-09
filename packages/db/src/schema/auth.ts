// auth.ts — Drizzle schema for the tenancy + authentication tables (03 §4, 17, ADR-0016/17/18).
// Single cohesive schema unit (exceeds the ~300-line guide by design; one table set, one responsibility).
// PII columns are encrypted at rest (KMS) at the app layer; ciphertext is stored as bytea.

import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// Case-insensitive text (emails, domains, slugs) and raw bytes (encrypted secrets).
const citext = customType<{ data: string }>({ dataType: () => "citext" });
const bytea = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });

const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`uuid_generate_v7()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ── Tenancy ──────────────────────────────────────────────────────────────────────────────────────────
export const tenants = pgTable("tenants", {
  id: id(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: citext("slug").notNull().unique(),
  plan: varchar("plan", { length: 50 }).notNull().default("free"),
  seatLimit: integer("seat_limit").notNull().default(1),
  workspaceLimit: integer("workspace_limit"),
  revealCreditBalance: integer("reveal_credit_balance").notNull().default(0),
  features: jsonb("features").notNull().default({}),
  status: varchar("status", { length: 50 }).notNull().default("active"),
  regionDefault: varchar("region_default", { length: 2 }).notNull().default("US"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable(
  "users",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: citext("email").notNull(),
    fullName: varchar("full_name", { length: 255 }),
    avatarUrl: varchar("avatar_url", { length: 500 }),
    passwordHash: varchar("password_hash", { length: 255 }), // Argon2id; null if SSO-only
    authProvider: varchar("auth_provider", { length: 50 }).notNull().default("password"),
    isTenantOwner: boolean("is_tenant_owner").notNull().default(false),
    scimExternalId: varchar("scim_external_id", { length: 255 }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    status: varchar("status", { length: 50 }).notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ uniqEmail: uniqueIndex("uniq_users_tenant_email").on(t.tenantId, t.email) }),
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    slug: citext("slug").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdByUserId: uuid("created_by_user_id"),
    settings: jsonb("settings").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ uniqSlug: uniqueIndex("uniq_workspaces_tenant_slug").on(t.tenantId, t.slug) }),
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 50 }).notNull().default("member"), // owner|admin|member|viewer
    invitedByUserId: uuid("invited_by_user_id"),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    status: varchar("status", { length: 50 }).notNull().default("invited"), // active|invited|removed
  },
  (t) => ({ uniqMember: uniqueIndex("uniq_member_ws_user").on(t.workspaceId, t.userId) }),
);

// ── Auth-origin tables (17, ADR-0016/17/18) ──────────────────────────────────────────────────────────
export const tenantDomains = pgTable("tenant_domains", {
  id: id(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  domain: citext("domain").notNull().unique(), // verified domain → exactly one tenant (ADR-0017)
  verificationToken: varchar("verification_token", { length: 255 }),
  dnsTxtRecord: text("dns_txt_record"),
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending|verified|failed
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const userSessions = pgTable("user_sessions", {
  id: varchar("id", { length: 255 }).primaryKey(), // Lucia session id (durable, on auth origin)
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id"),
  refreshTokenHash: varchar("refresh_token_hash", { length: 255 }), // rotating, reuse-detected
  rotatedFrom: varchar("rotated_from", { length: 255 }),
  appOrigin: varchar("app_origin", { length: 255 }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  ipAddress: text("ip_address"),
  userAgent: varchar("user_agent", { length: 500 }),
  createdAt: createdAt(),
});

export const userMfaMethods = pgTable("user_mfa_methods", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: varchar("type", { length: 20 }).notNull(), // totp|sms|email|webauthn
  secretEnc: bytea("secret_enc"), // encrypted TOTP/SMS/email secret
  label: varchar("label", { length: 100 }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const trustedDevices = pgTable(
  "trusted_devices",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fingerprintHash: varchar("fingerprint_hash", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }),
    lastIp: text("last_ip"),
    lastGeo: varchar("last_geo", { length: 100 }),
    trustedUntil: timestamp("trusted_until", { withTimezone: true }), // 30-day MFA-skip window
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({ uniqDevice: uniqueIndex("uniq_device_user_fp").on(t.userId, t.fingerprintHash) }),
);

export const tenantSsoConfigs = pgTable("tenant_sso_configs", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  protocol: varchar("protocol", { length: 10 }).notNull().default("saml"), // saml|oidc
  provider: varchar("provider", { length: 50 }).notNull(),
  metadataUrl: text("metadata_url"),
  metadataXml: text("metadata_xml"),
  oidcIssuer: text("oidc_issuer"),
  oidcClientId: varchar("oidc_client_id", { length: 255 }),
  oidcClientSecretEnc: bytea("oidc_client_secret_enc"),
  attributeMapping: jsonb("attribute_mapping").notNull().default({}),
  jitEnabled: boolean("jit_enabled").notNull().default(true),
  defaultRole: varchar("default_role", { length: 50 }).notNull().default("member"),
  enabled: boolean("enabled").notNull().default(false),
  enforced: boolean("enforced").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tenantAuthPolicies = pgTable("tenant_auth_policies", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  mfaEnforcement: varchar("mfa_enforcement", { length: 10 }).notNull().default("optional"),
  allowedMethods: jsonb("allowed_methods")
    .notNull()
    .default(["password", "oauth", "magic_link", "sso", "passkey"]),
  disableSocial: boolean("disable_social").notNull().default(false),
  requireSso: boolean("require_sso").notNull().default(false),
  ipAllowlist: text("ip_allowlist").array(),
  sessionTimeoutSeconds: integer("session_timeout_seconds"),
  updatedAt: updatedAt(),
});
