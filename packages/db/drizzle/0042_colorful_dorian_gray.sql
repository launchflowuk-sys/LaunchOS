CREATE TYPE "public"."package_kind" AS ENUM('retainer', 'one_off', 'addon');--> statement-breakpoint
CREATE TYPE "public"."portal_purchase_status" AS ENUM('pending', 'paid', 'trialing', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "portal_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" text,
	"package_id" uuid NOT NULL,
	"status" "portal_purchase_status" DEFAULT 'pending' NOT NULL,
	"stripe_session_id" text,
	"stripe_subscription_id" text,
	"stripe_customer_id" text,
	"amount_pence" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"trial_days" integer DEFAULT 0 NOT NULL,
	"project_id" uuid,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "kind" "package_kind" DEFAULT 'retainer' NOT NULL;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "self_serve" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "trial_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "portal_purchases" ADD CONSTRAINT "portal_purchases_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_purchases" ADD CONSTRAINT "portal_purchases_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_purchases" ADD CONSTRAINT "portal_purchases_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_purchases" ADD CONSTRAINT "portal_purchases_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_purchases" ADD CONSTRAINT "portal_purchases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_purchases_session" ON "portal_purchases" USING btree ("stripe_session_id");--> statement-breakpoint
CREATE INDEX "portal_purchases_client_time" ON "portal_purchases" USING btree ("client_id","created_at");