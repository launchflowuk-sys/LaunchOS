CREATE TABLE "site_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"rating" text,
	"count" integer DEFAULT 0 NOT NULL,
	"reviews" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"google_url" text,
	"fetched_at" timestamp with time zone,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failure_reason" text
);
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "google_place_id" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "reviews_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site_reviews" ADD CONSTRAINT "site_reviews_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_reviews" ADD CONSTRAINT "site_reviews_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_reviews_site" ON "site_reviews" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_org_slug" ON "sites" USING btree ("organisation_id","slug");