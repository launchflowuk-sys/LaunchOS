CREATE TYPE "public"."message_status" AS ENUM('queued', 'sent', 'failed', 'received');--> statement-breakpoint
CREATE TABLE "email_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"address" text NOT NULL,
	"display_name" text,
	"inbound_secret" text NOT NULL
);
--> statement-breakpoint
-- array_to_string(anyarray, text) is only STABLE in Postgres, so it cannot
-- be used directly inside a generated column ("generation expression is
-- not immutable"). text[] formatting has no locale/search_path dependency,
-- so pinning it as IMMUTABLE here is safe for the tags column below.
CREATE FUNCTION "array_to_string_immutable"(text[], text) RETURNS text
	LANGUAGE sql IMMUTABLE PARALLEL SAFE
	AS $$ SELECT array_to_string($1, $2) $$;--> statement-breakpoint
CREATE TABLE "knowledge_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"body_md" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body_md, '')), 'B') || setweight(to_tsvector('english', coalesce(array_to_string_immutable(tags, ' '), '')), 'C')) STORED
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "external_thread_key" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "participant_email" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "from_email" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "to_email" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "raw_headers" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "status" "message_status";--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "first_response_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "sla_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "triage" jsonb;--> statement-breakpoint
ALTER TABLE "email_identities" ADD CONSTRAINT "email_identities_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_identities" ADD CONSTRAINT "email_identities_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_articles" ADD CONSTRAINT "knowledge_articles_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_identities_client" ON "email_identities" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_identities_address" ON "email_identities" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_articles_org_slug" ON "knowledge_articles" USING btree ("organisation_id","slug");--> statement-breakpoint
CREATE INDEX "knowledge_articles_search" ON "knowledge_articles" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_org_thread_key" ON "conversations" USING btree ("organisation_id","external_thread_key");