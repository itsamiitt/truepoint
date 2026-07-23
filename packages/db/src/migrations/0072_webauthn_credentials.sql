CREATE TABLE IF NOT EXISTS "webauthn_credentials" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" text[],
	"aaguid" varchar(36),
	"backed_up" boolean DEFAULT false NOT NULL,
	"label" varchar(100),
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webauthn_credentials_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webauthn_credentials_user" ON "webauthn_credentials" ("user_id");
