CREATE TABLE "client_payment_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"external_customer_id" text NOT NULL,
	"email" text,
	"name" text,
	"is_primary" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_payment_accounts" ADD CONSTRAINT "client_payment_accounts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_payment_accounts" ADD CONSTRAINT "client_payment_accounts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_payment_accounts_provider_customer" ON "client_payment_accounts" USING btree ("provider","external_customer_id");--> statement-breakpoint
CREATE INDEX "client_payment_accounts_org_client" ON "client_payment_accounts" USING btree ("organisation_id","client_id");--> statement-breakpoint
-- Backfill: every billing profile that already carries a Stripe customer id
-- becomes that client's primary payment account. The billing name and the
-- client's email travel with it so the account reads like Stripe's record.
INSERT INTO "client_payment_accounts" ("organisation_id", "client_id", "provider", "external_customer_id", "email", "name", "is_primary")
SELECT bp."organisation_id", bp."client_id", 'stripe', bp."stripe_customer_id", c."email", coalesce(bp."billing_name", c."name"), true
FROM "billing_profiles" bp
JOIN "clients" c ON c."id" = bp."client_id"
WHERE bp."stripe_customer_id" IS NOT NULL
ON CONFLICT ("provider", "external_customer_id") DO NOTHING;
