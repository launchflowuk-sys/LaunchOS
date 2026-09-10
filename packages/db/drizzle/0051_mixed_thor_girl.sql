CREATE TYPE "public"."site_build_stage" AS ENUM('queued', 'generating', 'provisioning', 'uploading', 'review', 'approved', 'notified', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "site_builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"lead_id" uuid,
	"client_id" uuid,
	"domain" text NOT NULL,
	"stage" "site_build_stage" DEFAULT 'queued' NOT NULL,
	"hosting_username" text,
	"root_directory" text,
	"website_url" text,
	"admin_url" text,
	"generator_model" text,
	"generated" jsonb,
	"error" text,
	"approval_id" uuid,
	"review_ready_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "site_builds" ADD CONSTRAINT "site_builds_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_builds" ADD CONSTRAINT "site_builds_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_builds" ADD CONSTRAINT "site_builds_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_builds_org_domain" ON "site_builds" USING btree ("organisation_id","domain");--> statement-breakpoint
CREATE INDEX "site_builds_org_stage" ON "site_builds" USING btree ("organisation_id","stage");