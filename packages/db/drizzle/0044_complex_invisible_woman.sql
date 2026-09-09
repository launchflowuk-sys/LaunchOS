CREATE TYPE "public"."collection_method" AS ENUM('stripe', 'bank_transfer', 'standing_order', 'direct_debit', 'cash', 'other');--> statement-breakpoint
CREATE TABLE "subscription_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_amount_pence" integer DEFAULT 0 NOT NULL,
	"package_id" uuid,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "collection_method" "collection_method" DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "billing_notes" text;--> statement-breakpoint
ALTER TABLE "subscription_lines" ADD CONSTRAINT "subscription_lines_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_lines" ADD CONSTRAINT "subscription_lines_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_lines" ADD CONSTRAINT "subscription_lines_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscription_lines_subscription" ON "subscription_lines" USING btree ("subscription_id","sort");