CREATE TABLE IF NOT EXISTS "auth_email_tokens" (
	"token_hash" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"email" "citext" NOT NULL,
	"purpose" varchar(20) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invitations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid,
	"email" "citext" NOT NULL,
	"role" varchar(50) DEFAULT 'member' NOT NULL,
	"is_tenant_owner" boolean DEFAULT false NOT NULL,
	"token_hash" varchar(255) NOT NULL,
	"invited_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_auth_policies" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"mfa_enforcement" varchar(10) DEFAULT 'optional' NOT NULL,
	"allowed_methods" jsonb DEFAULT '["password","oauth","magic_link","sso","passkey"]'::jsonb NOT NULL,
	"disable_social" boolean DEFAULT false NOT NULL,
	"require_sso" boolean DEFAULT false NOT NULL,
	"ip_allowlist" text[],
	"session_timeout_seconds" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_domains" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"domain" "citext" NOT NULL,
	"verification_token" varchar(255),
	"dns_txt_record" text,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"join_policy" varchar(20) DEFAULT 'sso_only' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_domains_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_members" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"is_tenant_owner" boolean DEFAULT false NOT NULL,
	"status" varchar(50) DEFAULT 'active' NOT NULL,
	"invited_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_sso_configs" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"protocol" varchar(10) DEFAULT 'saml' NOT NULL,
	"provider" varchar(50) NOT NULL,
	"metadata_url" text,
	"metadata_xml" text,
	"oidc_issuer" text,
	"oidc_client_id" varchar(255),
	"oidc_client_secret_enc" "bytea",
	"attribute_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"jit_enabled" boolean DEFAULT true NOT NULL,
	"default_role" varchar(50) DEFAULT 'member' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"enforced" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenants" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" "citext" NOT NULL,
	"plan" varchar(50) DEFAULT 'free' NOT NULL,
	"seat_limit" integer DEFAULT 1 NOT NULL,
	"workspace_limit" integer,
	"reveal_credit_balance" integer DEFAULT 0 NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(50) DEFAULT 'active' NOT NULL,
	"region_default" varchar(2) DEFAULT 'US' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trusted_devices" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"user_id" uuid NOT NULL,
	"fingerprint_hash" varchar(255) NOT NULL,
	"name" varchar(255),
	"last_ip" text,
	"last_geo" varchar(100),
	"trusted_until" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_mfa_methods" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"secret_enc" "bytea",
	"label" varchar(100),
	"verified_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_sessions" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" uuid,
	"workspace_id" uuid,
	"device_id" uuid,
	"refresh_token_hash" varchar(255),
	"rotated_from" varchar(255),
	"app_origin" varchar(255),
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"ip_address" text,
	"user_agent" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"email" "citext" NOT NULL,
	"username" "citext",
	"full_name" varchar(255),
	"avatar_url" varchar(500),
	"password_hash" varchar(255),
	"auth_provider" varchar(50) DEFAULT 'password' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"scim_external_id" varchar(255),
	"last_login_at" timestamp with time zone,
	"status" varchar(50) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(50) DEFAULT 'member' NOT NULL,
	"invited_by_user_id" uuid,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"joined_at" timestamp with time zone,
	"status" varchar(50) DEFAULT 'invited' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" "citext" NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"domain" "citext",
	"linkedin_company_url" varchar(500),
	"sales_nav_account_url" varchar(500),
	"industry" varchar(100),
	"sub_industry" varchar(100),
	"employee_count" integer,
	"revenue_range" varchar(50),
	"hq_country" varchar(100),
	"hq_city" varchar(100),
	"icp_fit_score" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_icp_fit_range" CHECK ("accounts"."icp_fit_score" IS NULL OR "accounts"."icp_fit_score" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contacts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid,
	"first_name" varchar(100),
	"last_name" varchar(100),
	"email_enc" "bytea",
	"email_blind_index" "bytea",
	"email_domain" "citext",
	"email_status" varchar(20) DEFAULT 'unverified' NOT NULL,
	"linkedin_url" varchar(500),
	"linkedin_public_id" varchar(255),
	"sales_nav_profile_url" varchar(500),
	"sales_nav_lead_id" varchar(255),
	"job_title" varchar(255),
	"seniority_level" varchar(50),
	"department" varchar(100),
	"phone_enc" "bytea",
	"phone_status" varchar(50),
	"location_country" varchar(100),
	"location_city" varchar(100),
	"priority_score" integer,
	"outreach_status" varchar(50) DEFAULT 'new' NOT NULL,
	"is_revealed" boolean DEFAULT false NOT NULL,
	"revealed_by_user_id" uuid,
	"revealed_at" timestamp with time zone,
	"jurisdiction" char(2),
	"region" char(2) DEFAULT 'US' NOT NULL,
	"last_activity_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_email_status_enum" CHECK ("contacts"."email_status" IN ('unverified','valid','risky','invalid','catch_all','unknown')),
	CONSTRAINT "contacts_seniority_enum" CHECK ("contacts"."seniority_level" IS NULL OR "contacts"."seniority_level" IN ('c_suite','vp','director','manager','ic','other')),
	CONSTRAINT "contacts_outreach_status_enum" CHECK ("contacts"."outreach_status" IN ('new','in_sequence','replied','meeting_booked','disqualified','nurture','unsubscribed')),
	CONSTRAINT "contacts_priority_range" CHECK ("contacts"."priority_score" IS NULL OR "contacts"."priority_score" BETWEEN 0 AND 100),
	CONSTRAINT "contacts_reveal_owner" CHECK ("contacts"."is_revealed" = ("contacts"."revealed_by_user_id" IS NOT NULL)),
	CONSTRAINT "contacts_reveal_at" CHECK ("contacts"."is_revealed" = ("contacts"."revealed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_imports" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"imported_by_user_id" uuid,
	"source_name" varchar(50) NOT NULL,
	"source_file" varchar(255),
	"raw_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" "bytea",
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_imports_source_name_enum" CHECK ("source_imports"."source_name" IN ('apollo','zoominfo','linkedin','sales_navigator','hubspot','salesforce','clearbit','manual'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid,
	"actor_user_id" uuid,
	"action" varchar(50) NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" "inet",
	"user_agent" varchar(500),
	"origin_domain" varchar(255),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_action_enum" CHECK ("audit_log"."action" IN (
        'reveal','reveal.blocked','export','send','enroll','unsubscribe',
        'suppression.add','suppression.remove','consent.record','consent.withdraw',
        'dsar.access','dsar.delete','dsar.rectify','member.add','member.update','member.remove',
        'apikey.use','credit.adjust',
        'contact.create','contact.update','contact.delete','account.create','account.update','account.delete',
        'list.create','list.update','list.delete','sequence.create','sequence.update','sequence.delete',
        'template.create','template.update','template.delete','settings.update',
        'automation.rule.create','automation.rule.update','automation.rule.delete',
        'login.success','login.failure','login.locked','mfa.challenge','mfa.success','mfa.failure',
        'password.reset.request','password.reset.complete','sso.initiated','sso.callback',
        'token.issued','token.refresh','token.revoke','device.trusted','device.revoked','session.revoked',
        'code.issued','code.exchanged','signup','oauth.link'
      ))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_reveals" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"revealed_by_user_id" uuid NOT NULL,
	"reveal_type" varchar(20) NOT NULL,
	"data_source" varchar(20) DEFAULT 'internal' NOT NULL,
	"credits_consumed" integer DEFAULT 1 NOT NULL,
	"revealed_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revealed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_reveals_type_enum" CHECK ("contact_reveals"."reveal_type" IN ('email','phone','full_profile')),
	CONSTRAINT "contact_reveals_source_enum" CHECK ("contact_reveals"."data_source" IN ('apollo','zoominfo','linkedin','internal')),
	CONSTRAINT "contact_reveals_credits_nonneg" CHECK ("contact_reveals"."credits_consumed" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" varchar(255) NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchases" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stripe_event_id" varchar(255) NOT NULL,
	"stripe_payment_intent_id" varchar(255),
	"credits" integer NOT NULL,
	"amount_cents" integer,
	"status" varchar(20) DEFAULT 'completed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchases_stripe_event_id_unique" UNIQUE("stripe_event_id"),
	CONSTRAINT "purchases_credits_positive" CHECK ("purchases"."credits" > 0),
	CONSTRAINT "purchases_status_enum" CHECK ("purchases"."status" IN ('completed','refunded'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stripe_customers" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"stripe_customer_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_customers_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "suppression_list" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"scope" varchar(20) NOT NULL,
	"tenant_id" uuid,
	"workspace_id" uuid,
	"match_type" varchar(20) NOT NULL,
	"email_blind_index" "bytea",
	"domain" "citext",
	"phone_blind_index" "bytea",
	"contact_id" uuid,
	"reason" varchar(255),
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppression_scope_enum" CHECK ("suppression_list"."scope" IN ('global','tenant','workspace')),
	CONSTRAINT "suppression_match_enum" CHECK ("suppression_list"."match_type" IN ('email','domain','phone','contact_id')),
	CONSTRAINT "suppression_scope_coherence" CHECK (("suppression_list"."scope" = 'global' AND "suppression_list"."tenant_id" IS NULL AND "suppression_list"."workspace_id" IS NULL)
       OR ("suppression_list"."scope" = 'tenant' AND "suppression_list"."tenant_id" IS NOT NULL AND "suppression_list"."workspace_id" IS NULL)
       OR ("suppression_list"."scope" = 'workspace' AND "suppression_list"."tenant_id" IS NOT NULL AND "suppression_list"."workspace_id" IS NOT NULL)),
	CONSTRAINT "suppression_match_key_present" CHECK (("suppression_list"."match_type" = 'email' AND "suppression_list"."email_blind_index" IS NOT NULL)
       OR ("suppression_list"."match_type" = 'domain' AND "suppression_list"."domain" IS NOT NULL)
       OR ("suppression_list"."match_type" = 'phone' AND "suppression_list"."phone_blind_index" IS NOT NULL)
       OR ("suppression_list"."match_type" = 'contact_id' AND "suppression_list"."contact_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intent_signals" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"signal_type" varchar(50) NOT NULL,
	"signal_source" varchar(50),
	"detail" varchar(500),
	"weight" integer DEFAULT 1 NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intent_signals_type_enum" CHECK ("intent_signals"."signal_type" IN ('job_change','new_hire','funding_round','tech_install','web_visit',
        'content_engagement','keyword_search','linkedin_activity','sales_nav_view')),
	CONSTRAINT "intent_signals_weight_range" CHECK ("intent_signals"."weight" BETWEEN 1 AND 10)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_calls" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider_name" varchar(50) NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"status" varchar(20) NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"response_payload" jsonb,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_calls_status_enum" CHECK ("provider_calls"."status" IN ('hit','miss','rate_limited','error'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scores" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"icp_fit" integer NOT NULL,
	"intent_score" integer NOT NULL,
	"engagement_score" integer NOT NULL,
	"composite_score" integer NOT NULL,
	"score_breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scores_ranges" CHECK ("scores"."icp_fit" BETWEEN 0 AND 100 AND "scores"."intent_score" BETWEEN 0 AND 100
       AND "scores"."engagement_score" BETWEEN 0 AND 100 AND "scores"."composite_score" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"jurisdiction" varchar(2) NOT NULL,
	"lawful_basis" varchar(50) NOT NULL,
	"source" varchar(255),
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_basis_enum" CHECK ("consent_records"."lawful_basis" IN ('legitimate_interest','consent','contract','public_record'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dsar_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"request_type" varchar(20) NOT NULL,
	"subject_email_enc" "bytea" NOT NULL,
	"subject_email_blind_index" "bytea" NOT NULL,
	"status" varchar(30) DEFAULT 'received' NOT NULL,
	"scope_report" jsonb,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "dsar_type_enum" CHECK ("dsar_requests"."request_type" IN ('access','delete','rectify')),
	CONSTRAINT "dsar_status_enum" CHECK ("dsar_requests"."status" IN ('received','verifying','processing','completed','rejected'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activities" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"activity_type" varchar(30) NOT NULL,
	"channel" varchar(20) NOT NULL,
	"outcome" varchar(20),
	"note" varchar(2000),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_type_enum" CHECK ("activities"."activity_type" IN ('email_sent','email_opened','email_clicked','email_replied','call_made',
        'call_connected','linkedin_message','linkedin_connected','sales_nav_inmail','meeting_held','note_added')),
	CONSTRAINT "activities_channel_enum" CHECK ("activities"."channel" IN ('email','phone','linkedin','sales_navigator','in-person')),
	CONSTRAINT "activities_outcome_enum" CHECK ("activities"."outcome" IS NULL OR "activities"."outcome" IN ('connected','voicemail','no_answer','positive','negative','neutral'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_nav_links" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"link_type" varchar(30) NOT NULL,
	"url" varchar(500) NOT NULL,
	"external_id" varchar(255),
	"contact_id" uuid,
	"account_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_nav_links_type_enum" CHECK ("sales_nav_links"."link_type" IN ('profile','account','saved_search','lead_list','account_list','inmail_thread'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outreach_log" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'enrolled' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"last_event_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outreach_log_status_enum" CHECK ("outreach_log"."status" IN ('enrolled','active','replied','completed','unsubscribed','bounced'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outreach_sequences" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"from_address" varchar(255),
	"physical_address" varchar(500),
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outreach_sequences_status_enum" CHECK ("outreach_sequences"."status" IN ('active','paused','archived'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outreach_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"step_order" integer NOT NULL,
	"channel" varchar(20) DEFAULT 'email' NOT NULL,
	"delay_hours" integer DEFAULT 0 NOT NULL,
	"subject" varchar(255),
	"body" varchar(5000) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outreach_steps_channel_enum" CHECK ("outreach_steps"."channel" IN ('email','linkedin')),
	CONSTRAINT "outreach_steps_delay_nonneg" CHECK ("outreach_steps"."delay_hours" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_email_tokens" ADD CONSTRAINT "auth_email_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_auth_policies" ADD CONSTRAINT "tenant_auth_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_sso_configs" ADD CONSTRAINT "tenant_sso_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_mfa_methods" ADD CONSTRAINT "user_mfa_methods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounts" ADD CONSTRAINT "accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contacts" ADD CONSTRAINT "contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contacts" ADD CONSTRAINT "contacts_revealed_by_user_id_users_id_fk" FOREIGN KEY ("revealed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "source_imports" ADD CONSTRAINT "source_imports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "source_imports" ADD CONSTRAINT "source_imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "source_imports" ADD CONSTRAINT "source_imports_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "source_imports" ADD CONSTRAINT "source_imports_imported_by_user_id_users_id_fk" FOREIGN KEY ("imported_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact_reveals" ADD CONSTRAINT "contact_reveals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact_reveals" ADD CONSTRAINT "contact_reveals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact_reveals" ADD CONSTRAINT "contact_reveals_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact_reveals" ADD CONSTRAINT "contact_reveals_revealed_by_user_id_users_id_fk" FOREIGN KEY ("revealed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchases" ADD CONSTRAINT "purchases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stripe_customers" ADD CONSTRAINT "stripe_customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "suppression_list" ADD CONSTRAINT "suppression_list_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "suppression_list" ADD CONSTRAINT "suppression_list_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "suppression_list" ADD CONSTRAINT "suppression_list_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "suppression_list" ADD CONSTRAINT "suppression_list_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intent_signals" ADD CONSTRAINT "intent_signals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intent_signals" ADD CONSTRAINT "intent_signals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intent_signals" ADD CONSTRAINT "intent_signals_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scores" ADD CONSTRAINT "scores_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scores" ADD CONSTRAINT "scores_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scores" ADD CONSTRAINT "scores_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activities" ADD CONSTRAINT "activities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activities" ADD CONSTRAINT "activities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activities" ADD CONSTRAINT "activities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activities" ADD CONSTRAINT "activities_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_nav_links" ADD CONSTRAINT "sales_nav_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_nav_links" ADD CONSTRAINT "sales_nav_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_nav_links" ADD CONSTRAINT "sales_nav_links_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_nav_links" ADD CONSTRAINT "sales_nav_links_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_nav_links" ADD CONSTRAINT "sales_nav_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_log" ADD CONSTRAINT "outreach_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_log" ADD CONSTRAINT "outreach_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_log" ADD CONSTRAINT "outreach_log_sequence_id_outreach_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."outreach_sequences"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_log" ADD CONSTRAINT "outreach_log_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_sequences" ADD CONSTRAINT "outreach_sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_sequences" ADD CONSTRAINT "outreach_sequences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_sequences" ADD CONSTRAINT "outreach_sequences_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_steps" ADD CONSTRAINT "outreach_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_steps" ADD CONSTRAINT "outreach_steps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_steps" ADD CONSTRAINT "outreach_steps_sequence_id_outreach_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."outreach_sequences"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_tenant_member" ON "tenant_members" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_device_user_fp" ON "trusted_devices" USING btree ("user_id","fingerprint_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_member_ws_user" ON "workspace_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_workspaces_tenant_slug" ON "workspaces" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_accounts_ws_domain" ON "accounts" USING btree ("workspace_id","domain") WHERE "accounts"."domain" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_contacts_ws_email" ON "contacts" USING btree ("workspace_id","email_blind_index") WHERE "contacts"."email_blind_index" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_contacts_ws_linkedin" ON "contacts" USING btree ("workspace_id","linkedin_public_id") WHERE "contacts"."linkedin_public_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_contacts_ws_salesnav" ON "contacts" USING btree ("workspace_id","sales_nav_lead_id") WHERE "contacts"."sales_nav_lead_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_source_imports_ws_content" ON "source_imports" USING btree ("workspace_id","content_hash") WHERE "source_imports"."content_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_contact_reveals_claim" ON "contact_reveals" USING btree ("workspace_id","contact_id","reveal_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_idempotency_tenant_key" ON "idempotency_keys" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_provider_calls_ws_hash" ON "provider_calls" USING btree ("workspace_id","request_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activities_ws_contact_occurred" ON "activities" USING btree ("workspace_id","contact_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_sales_nav_links_ws_url" ON "sales_nav_links" USING btree ("workspace_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_outreach_log_seq_contact" ON "outreach_log" USING btree ("sequence_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_outreach_sequences_ws_name" ON "outreach_sequences" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_outreach_steps_seq_order" ON "outreach_steps" USING btree ("sequence_id","step_order");