CREATE TYPE "public"."cost_business" AS ENUM('launchflow', 'cabio', 'grays_cabline', 'mobile_pc_doctor', 'agent_zero', 'nexus_education', 'strix', 'grays_park_masjid', 'shared');--> statement-breakpoint
CREATE TYPE "public"."cost_source" AS ENUM('sync', 'manual');--> statement-breakpoint
CREATE TYPE "public"."vat_treatment" AS ENUM('standard', 'reverse_charge', 'exempt', 'none');--> statement-breakpoint
ALTER TYPE "public"."supplier" ADD VALUE 'hetzner';--> statement-breakpoint
ALTER TYPE "public"."supplier" ADD VALUE 'coolify';--> statement-breakpoint
ALTER TYPE "public"."supplier" ADD VALUE 'anthropic';--> statement-breakpoint
ALTER TYPE "public"."supplier" ADD VALUE 'openai';--> statement-breakpoint
ALTER TYPE "public"."supplier" ADD VALUE 'google';--> statement-breakpoint
ALTER TYPE "public"."supplier" ADD VALUE 'mapbox';--> statement-breakpoint
ALTER TYPE "public"."supplier" ADD VALUE 'github';--> statement-breakpoint
ALTER TYPE "public"."supplier" ADD VALUE 'postmark';--> statement-breakpoint
ALTER TYPE "public"."supplier" ADD VALUE 'twilio';--> statement-breakpoint
ALTER TYPE "public"."supplier" ADD VALUE 'screenshotone';--> statement-breakpoint
ALTER TYPE "public"."supplier" ADD VALUE 'stripe';--> statement-breakpoint
ALTER TYPE "public"."supplier" ADD VALUE 'apple';--> statement-breakpoint
ALTER TYPE "public"."supplier" ADD VALUE 'expo';--> statement-breakpoint
ALTER TYPE "public"."supplier" ADD VALUE 'microsoft';--> statement-breakpoint
ALTER TYPE "public"."supplier" ADD VALUE 'other';--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"day" date NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"rate_micros" integer NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supplier_costs" ALTER COLUMN "external_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_costs" ADD COLUMN "source" "cost_source" DEFAULT 'sync' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_costs" ADD COLUMN "business" "cost_business" DEFAULT 'launchflow' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_costs" ADD COLUMN "vat_treatment" "vat_treatment" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_costs" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_day" ON "fx_rates" USING btree ("organisation_id","day","base","quote");--> statement-breakpoint
CREATE INDEX "fx_rates_lookup" ON "fx_rates" USING btree ("organisation_id","base","quote","day");--> statement-breakpoint
CREATE INDEX "supplier_costs_business" ON "supplier_costs" USING btree ("organisation_id","business");