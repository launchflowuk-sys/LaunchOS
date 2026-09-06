CREATE TYPE "public"."funnel_session_status" AS ENUM('started', 'contacted', 'completed');--> statement-breakpoint
CREATE TYPE "public"."funnel_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TABLE "ad_campaign_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"date" date NOT NULL,
	"campaign_external_id" text NOT NULL,
	"campaign_name" text NOT NULL,
	"spend_pence" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"conversions" integer DEFAULT 0 NOT NULL,
	"conversion_value_pence" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funnel_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"funnel_id" uuid NOT NULL,
	"lead_id" uuid,
	"token" text NOT NULL,
	"status" "funnel_session_status" DEFAULT 'started' NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"answered" integer DEFAULT 0 NOT NULL,
	"contacted_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "funnels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"client_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"headline" text DEFAULT '' NOT NULL,
	"subheadline" text DEFAULT '' NOT NULL,
	"status" "funnel_status" DEFAULT 'draft' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"success" jsonb DEFAULT '{"headline":"Thank you — that is everything we need","body":"We read every enquiry ourselves. Expect a reply within one working day."}'::jsonb NOT NULL,
	"hot_score" integer DEFAULT 0 NOT NULL,
	"lead_source" text DEFAULT 'funnel' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_campaign_snapshots" ADD CONSTRAINT "ad_campaign_snapshots_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaign_snapshots" ADD CONSTRAINT "ad_campaign_snapshots_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_sessions" ADD CONSTRAINT "funnel_sessions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_sessions" ADD CONSTRAINT "funnel_sessions_funnel_id_funnels_id_fk" FOREIGN KEY ("funnel_id") REFERENCES "public"."funnels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_sessions" ADD CONSTRAINT "funnel_sessions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnels" ADD CONSTRAINT "funnels_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnels" ADD CONSTRAINT "funnels_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_campaign_snapshots_account_date_campaign" ON "ad_campaign_snapshots" USING btree ("ad_account_id","date","campaign_external_id");--> statement-breakpoint
CREATE INDEX "ad_campaign_snapshots_org_date" ON "ad_campaign_snapshots" USING btree ("organisation_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_sessions_token" ON "funnel_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "funnel_sessions_org_funnel_created" ON "funnel_sessions" USING btree ("organisation_id","funnel_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "funnels_org_slug" ON "funnels" USING btree ("organisation_id","slug");--> statement-breakpoint
CREATE INDEX "funnels_org_status" ON "funnels" USING btree ("organisation_id","status");