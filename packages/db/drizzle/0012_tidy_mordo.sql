CREATE TYPE "public"."site_credential_kind" AS ENUM('wordpress_app_password');--> statement-breakpoint
CREATE TABLE "site_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"kind" "site_credential_kind" NOT NULL,
	"username" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"created_by" text
);
--> statement-breakpoint
ALTER TABLE "site_credentials" ADD CONSTRAINT "site_credentials_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_credentials" ADD CONSTRAINT "site_credentials_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_credentials_site_kind" ON "site_credentials" USING btree ("site_id","kind");