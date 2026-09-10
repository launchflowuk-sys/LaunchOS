CREATE TYPE "public"."brief_asset_status" AS ENUM('pending', 'scanning', 'ready', 'rejected', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."brief_session_status" AS ENUM('draft', 'submitted', 'expired');--> statement-breakpoint
CREATE TABLE "brief_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"original_name" text NOT NULL,
	"detected_mime" text,
	"bytes" bigint NOT NULL,
	"checksum" text,
	"status" "brief_asset_status" DEFAULT 'pending' NOT NULL,
	"rejected_reason" text,
	CONSTRAINT "brief_assets_bytes_non_negative" CHECK ("brief_assets"."bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "brief_mutations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"mutation_id" text NOT NULL,
	"result_revision" bigint NOT NULL,
	"request_digest" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brief_resume_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "brief_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"lead_id" uuid,
	"session_secret_hash" text NOT NULL,
	"questionnaire_version" integer NOT NULL,
	"current_step" integer DEFAULT 1 NOT NULL,
	"completed_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"status" "brief_session_status" DEFAULT 'draft' NOT NULL,
	"source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "brief_sessions_revision_non_negative" CHECK ("brief_sessions"."revision" >= 0),
	CONSTRAINT "brief_sessions_step_range" CHECK ("brief_sessions"."current_step" between 1 and 8)
);
--> statement-breakpoint
CREATE TABLE "brief_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"submission_version" integer DEFAULT 1 NOT NULL,
	"answers" jsonb NOT NULL,
	"source_revision" bigint NOT NULL,
	"questionnaire_version" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"reference" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brief_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"structured" jsonb,
	"markdown" text NOT NULL,
	"generator_version" text NOT NULL,
	"schema_version" text,
	"model" text
);
--> statement-breakpoint
ALTER TABLE "brief_assets" ADD CONSTRAINT "brief_assets_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_assets" ADD CONSTRAINT "brief_assets_session_id_brief_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."brief_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_mutations" ADD CONSTRAINT "brief_mutations_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_mutations" ADD CONSTRAINT "brief_mutations_session_id_brief_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."brief_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_resume_tokens" ADD CONSTRAINT "brief_resume_tokens_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_resume_tokens" ADD CONSTRAINT "brief_resume_tokens_session_id_brief_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."brief_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_sessions" ADD CONSTRAINT "brief_sessions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_sessions" ADD CONSTRAINT "brief_sessions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_submissions" ADD CONSTRAINT "brief_submissions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_submissions" ADD CONSTRAINT "brief_submissions_session_id_brief_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."brief_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_versions" ADD CONSTRAINT "brief_versions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_versions" ADD CONSTRAINT "brief_versions_submission_id_brief_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."brief_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brief_assets_storage_key" ON "brief_assets" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "brief_assets_session_status" ON "brief_assets" USING btree ("session_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "brief_mutations_session_mutation" ON "brief_mutations" USING btree ("session_id","mutation_id");--> statement-breakpoint
CREATE INDEX "brief_mutations_created" ON "brief_mutations" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "brief_resume_tokens_hash" ON "brief_resume_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "brief_resume_tokens_session" ON "brief_resume_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "brief_resume_tokens_expiry" ON "brief_resume_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "brief_sessions_secret" ON "brief_sessions" USING btree ("session_secret_hash");--> statement-breakpoint
CREATE INDEX "brief_sessions_org_lead" ON "brief_sessions" USING btree ("organisation_id","lead_id");--> statement-breakpoint
CREATE INDEX "brief_sessions_org_status_activity" ON "brief_sessions" USING btree ("organisation_id","status","last_activity_at");--> statement-breakpoint
CREATE INDEX "brief_sessions_expiry" ON "brief_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "brief_submissions_session_idempotency" ON "brief_submissions" USING btree ("session_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "brief_submissions_session_version" ON "brief_submissions" USING btree ("session_id","submission_version");--> statement-breakpoint
CREATE UNIQUE INDEX "brief_submissions_reference" ON "brief_submissions" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "brief_submissions_org_submitted" ON "brief_submissions" USING btree ("organisation_id","submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "brief_versions_submission_version" ON "brief_versions" USING btree ("submission_id","version");--> statement-breakpoint
CREATE INDEX "brief_versions_submission" ON "brief_versions" USING btree ("submission_id");