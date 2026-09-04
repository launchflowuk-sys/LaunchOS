CREATE TYPE "public"."dns_provider" AS ENUM('cloudflare', 'registrar', 'other');--> statement-breakpoint
CREATE TABLE "billing_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"billing_name" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"postcode" text,
	"country" text DEFAULT 'GB' NOT NULL,
	"vat_number" text,
	"payment_terms_days" integer DEFAULT 14 NOT NULL,
	"stripe_customer_id" text,
	"preferred_method" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"client_id" uuid,
	"site_id" uuid,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_profiles_client" ON "billing_profiles" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_events_client_time" ON "activity_events" USING btree ("client_id","created_at");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_unread" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "address_line1" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "address_line2" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "postcode" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "country" text DEFAULT 'GB' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "website_url" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "industry" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "support_email" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "package_id" uuid;--> statement-breakpoint
UPDATE "clients" AS c SET "slug" = base.slug || CASE WHEN base.rn = 1 THEN '' ELSE '-' || base.rn::text END
  FROM (
    SELECT id,
           trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')) AS slug,
           row_number() OVER (
             PARTITION BY organisation_id, trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'))
             ORDER BY created_at, id
           ) AS rn
    FROM "clients"
  ) AS base
  WHERE c.id = base.id AND c."slug" IS NULL;--> statement-breakpoint
ALTER TABLE "clients" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_org_slug" ON "clients" USING btree ("organisation_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_support_email" ON "clients" USING btree ("support_email");--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "dns_provider" "dns_provider" DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "nameservers" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "notes" text;--> statement-breakpoint
UPDATE "domains" AS d SET "client_id" = s."client_id" FROM "sites" AS s WHERE s.id = d.site_id AND d."client_id" IS NULL;--> statement-breakpoint
ALTER TABLE "domains" ALTER COLUMN "client_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ALTER COLUMN "site_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" DROP CONSTRAINT "domains_site_id_sites_id_fk";--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_members" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "organisation_members" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "organisation_members" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "organisation_members" ADD COLUMN "invited_by" text;--> statement-breakpoint
ALTER TABLE "organisation_members" ADD COLUMN "initial_password_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organisation_members" ADD CONSTRAINT "organisation_members_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_users" ADD CONSTRAINT "client_users_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
