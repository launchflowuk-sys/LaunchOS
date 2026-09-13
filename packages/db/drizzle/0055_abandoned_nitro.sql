CREATE TYPE "public"."usage_product" AS ENUM('tokens_in', 'tokens_in_cached', 'tokens_cache_write', 'tokens_out', 'image', 'screenshot', 'email', 'message');--> statement-breakpoint
CREATE TYPE "public"."usage_source" AS ENUM('agent_run', 'brief_writer', 'site_build', 'content_draft', 'image_render', 'screenshot', 'email_send', 'message_send', 'other');--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"client_id" uuid,
	"business" "cost_business" DEFAULT 'launchflow' NOT NULL,
	"supplier" "supplier" NOT NULL,
	"product" "usage_product" NOT NULL,
	"variant" text,
	"quantity" bigint NOT NULL,
	"unit" text DEFAULT 'token' NOT NULL,
	"cost_pence" integer DEFAULT 0 NOT NULL,
	"rate_id" uuid,
	"source" "usage_source" DEFAULT 'other' NOT NULL,
	"source_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" text
);
--> statement-breakpoint
CREATE TABLE "usage_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"supplier" "supplier" NOT NULL,
	"product" "usage_product" NOT NULL,
	"variant" text,
	"micro_pence_per_unit" bigint NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_rates" ADD CONSTRAINT "usage_rates_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_idempotent" ON "usage_events" USING btree ("organisation_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "usage_events_month" ON "usage_events" USING btree ("organisation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_client" ON "usage_events" USING btree ("organisation_id","client_id","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_business" ON "usage_events" USING btree ("organisation_id","business","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_rates_lookup" ON "usage_rates" USING btree ("organisation_id","supplier","product","variant","effective_from");