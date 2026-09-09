CREATE TYPE "public"."cost_match" AS ENUM('unassigned', 'suggested', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."supplier" AS ENUM('hostinger');--> statement-breakpoint
CREATE TABLE "supplier_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"supplier" "supplier" NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"renewal_price" integer DEFAULT 0 NOT NULL,
	"total_price" integer DEFAULT 0 NOT NULL,
	"currency_code" text DEFAULT 'USD' NOT NULL,
	"billing_period" integer DEFAULT 1 NOT NULL,
	"billing_period_unit" text DEFAULT 'year' NOT NULL,
	"auto_renewed" boolean DEFAULT true NOT NULL,
	"next_billing_at" timestamp with time zone,
	"client_id" uuid,
	"domain_id" uuid,
	"match" "cost_match" DEFAULT 'unassigned' NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supplier_costs" ADD CONSTRAINT "supplier_costs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_costs" ADD CONSTRAINT "supplier_costs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_costs" ADD CONSTRAINT "supplier_costs_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_costs_external" ON "supplier_costs" USING btree ("organisation_id","supplier","external_id");--> statement-breakpoint
CREATE INDEX "supplier_costs_client" ON "supplier_costs" USING btree ("organisation_id","client_id");--> statement-breakpoint
CREATE INDEX "supplier_costs_billing" ON "supplier_costs" USING btree ("organisation_id","next_billing_at");