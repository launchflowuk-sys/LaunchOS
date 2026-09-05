CREATE TYPE "public"."content_asset_source" AS ENUM('client', 'staff', 'generated');--> statement-breakpoint
CREATE TYPE "public"."content_channel" AS ENUM('facebook', 'instagram', 'blog', 'gbp');--> statement-breakpoint
CREATE TYPE "public"."content_kind" AS ENUM('social_post', 'blog_post', 'gbp_update');--> statement-breakpoint
CREATE TYPE "public"."content_report_status" AS ENUM('draft', 'approved', 'sent');--> statement-breakpoint
CREATE TYPE "public"."content_source" AS ENUM('agent', 'staff', 'client');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('draft', 'awaiting_approval', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'rejected', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."approval_kind" ADD VALUE 'content_publish';--> statement-breakpoint
CREATE TABLE "content_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"path" text NOT NULL,
	"mime" text NOT NULL,
	"alt" text,
	"source" "content_asset_source" DEFAULT 'staff' NOT NULL,
	"uploaded_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "content_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"tone" text,
	"audience" text,
	"services" text,
	"offers" text,
	"area" text,
	"do_not_say" text,
	"notes" text,
	"updated_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "content_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"channel" "content_channel" NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"channel" "content_channel" NOT NULL,
	"kind" "content_kind" NOT NULL,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"period_key" text NOT NULL,
	"title" text,
	"body" text,
	"image_url" text,
	"image_prompt" text,
	"link_url" text,
	"scheduled_for" timestamp with time zone,
	"published_at" timestamp with time zone,
	"external_id" text,
	"external_url" text,
	"last_error" text,
	"source" "content_source" DEFAULT 'staff' NOT NULL,
	"suggested_by_user_id" text,
	"approval_id" uuid,
	"task_id" uuid
);
--> statement-breakpoint
CREATE TABLE "content_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"summary_md" text NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "content_report_status" DEFAULT 'draft' NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_briefs" ADD CONSTRAINT "content_briefs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_briefs" ADD CONSTRAINT "content_briefs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_briefs" ADD CONSTRAINT "content_briefs_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_channels" ADD CONSTRAINT "content_channels_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_channels" ADD CONSTRAINT "content_channels_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_suggested_by_user_id_user_id_fk" FOREIGN KEY ("suggested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_assets_org_client" ON "content_assets" USING btree ("organisation_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_briefs_org_client" ON "content_briefs" USING btree ("organisation_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_channels_org_client_channel" ON "content_channels" USING btree ("organisation_id","client_id","channel");--> statement-breakpoint
CREATE INDEX "content_items_org_client_period" ON "content_items" USING btree ("organisation_id","client_id","period_key");--> statement-breakpoint
CREATE INDEX "content_items_org_status_scheduled" ON "content_items" USING btree ("organisation_id","status","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "content_items_planned_slot" ON "content_items" USING btree ("organisation_id","client_id","period_key","channel",("metadata" ->> 'slot')) WHERE "content_items"."metadata" ->> 'slot' is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "content_reports_org_client_period" ON "content_reports" USING btree ("organisation_id","client_id","period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_pending_content_publish" ON "approvals" USING btree ("organisation_id",("payload" ->> 'itemId')) WHERE "approvals"."status" = 'pending' and "approvals"."payload" ->> 'action' = 'content_publish';