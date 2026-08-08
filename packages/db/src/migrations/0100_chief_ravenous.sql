CREATE TABLE "master_technologies" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"canonical_name" varchar(200) NOT NULL,
	"slug" "citext" NOT NULL,
	"kind" varchar(20) DEFAULT 'technology' NOT NULL,
	"description" text,
	"category_id" uuid,
	"vendor_domain" "citext",
	"is_open_source" boolean,
	"is_saas" boolean,
	"pricing_model" varchar(20)[] DEFAULT '{}' NOT NULL,
	"cpe23" varchar(255),
	"wikidata_qid" varchar(32),
	"implies_tech_ids" uuid[] DEFAULT '{}' NOT NULL,
	"requires_tech_ids" uuid[] DEFAULT '{}' NOT NULL,
	"excludes_tech_ids" uuid[] DEFAULT '{}' NOT NULL,
	"block_key" varchar(255),
	"field_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prov_hwm" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_technologies_kind_enum" CHECK ("master_technologies"."kind" IN ('technology','product','service'))
);
--> statement-breakpoint
CREATE TABLE "master_technology_aliases" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"technology_id" uuid NOT NULL,
	"alias" "citext" NOT NULL,
	"alias_type" varchar(20),
	"source_name" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_technology_aliases_type_enum" CHECK ("master_technology_aliases"."alias_type" IS NULL OR "master_technology_aliases"."alias_type" IN ('rename','abbreviation','misspelling','locale'))
);
--> statement-breakpoint
CREATE TABLE "master_technology_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"name" varchar(120) NOT NULL,
	"slug" "citext" NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "master_technology_features" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"technology_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"source_name" varchar(50),
	"observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "master_technology_vendors" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"technology_id" uuid NOT NULL,
	"master_company_id" uuid NOT NULL,
	"relationship" varchar(20) NOT NULL,
	"started_on" date DEFAULT '-infinity' NOT NULL,
	"ended_on" date,
	"source_name" varchar(50),
	"confidence" numeric(4, 3),
	"observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_technology_vendors_relationship_enum" CHECK ("master_technology_vendors"."relationship" IN ('creator','current_owner','former_owner')),
	CONSTRAINT "master_technology_vendors_confidence_range" CHECK ("master_technology_vendors"."confidence" IS NULL OR "master_technology_vendors"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "master_technology_vendors_ended_after_started" CHECK ("master_technology_vendors"."ended_on" IS NULL OR "master_technology_vendors"."ended_on" >= "master_technology_vendors"."started_on")
);
--> statement-breakpoint
ALTER TABLE "master_technologies" ADD CONSTRAINT "master_technologies_category_id_master_technology_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."master_technology_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_technology_aliases" ADD CONSTRAINT "master_technology_aliases_technology_id_master_technologies_id_fk" FOREIGN KEY ("technology_id") REFERENCES "public"."master_technologies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_technology_categories" ADD CONSTRAINT "master_technology_categories_parent_id_master_technology_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."master_technology_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_technology_features" ADD CONSTRAINT "master_technology_features_technology_id_master_technologies_id_fk" FOREIGN KEY ("technology_id") REFERENCES "public"."master_technologies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_technology_vendors" ADD CONSTRAINT "master_technology_vendors_technology_id_master_technologies_id_fk" FOREIGN KEY ("technology_id") REFERENCES "public"."master_technologies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_technology_vendors" ADD CONSTRAINT "master_technology_vendors_master_company_id_master_companies_id_fk" FOREIGN KEY ("master_company_id") REFERENCES "public"."master_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_master_technologies_slug" ON "master_technologies" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_master_technologies_cpe" ON "master_technologies" USING btree ("cpe23") WHERE "master_technologies"."cpe23" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_master_technologies_wikidata" ON "master_technologies" USING btree ("wikidata_qid") WHERE "master_technologies"."wikidata_qid" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_master_technologies_category" ON "master_technologies" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_master_technology_aliases" ON "master_technology_aliases" USING btree ("alias","technology_id");--> statement-breakpoint
CREATE INDEX "idx_master_technology_aliases_lookup" ON "master_technology_aliases" USING btree ("alias");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_master_technology_categories_slug" ON "master_technology_categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_master_technology_categories_parent" ON "master_technology_categories" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_master_technology_features" ON "master_technology_features" USING btree ("technology_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_master_technology_vendors_link" ON "master_technology_vendors" USING btree ("technology_id","master_company_id","relationship","started_on");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_master_technology_current_owner" ON "master_technology_vendors" USING btree ("technology_id") WHERE "master_technology_vendors"."relationship" = 'current_owner' AND "master_technology_vendors"."ended_on" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_master_technology_vendors_company" ON "master_technology_vendors" USING btree ("master_company_id","relationship");