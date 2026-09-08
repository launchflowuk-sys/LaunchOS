CREATE TABLE "site_screenshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"bytes" "bytea",
	"mime" text,
	"width" integer,
	"height" integer,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"adapter" text NOT NULL,
	"captured_at" timestamp with time zone,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failure_reason" text
);
--> statement-breakpoint
ALTER TABLE "site_screenshots" ADD CONSTRAINT "site_screenshots_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_screenshots" ADD CONSTRAINT "site_screenshots_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_screenshots_site" ON "site_screenshots" USING btree ("site_id");