CREATE TYPE "public"."client_access_kind" AS ENUM('dashboard', 'server', 'ssh', 'database', 'dns', 'registrar', 'hosting_panel', 'email', 'other');--> statement-breakpoint
CREATE TABLE "client_access_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"site_id" uuid,
	"kind" "client_access_kind" NOT NULL,
	"label" text NOT NULL,
	"url" text,
	"host" text,
	"port" integer,
	"username" text,
	"secret_ciphertext" text,
	"notes" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"last_viewed_by" text,
	"created_by" text,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "client_access_entries" ADD CONSTRAINT "client_access_entries_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_access_entries" ADD CONSTRAINT "client_access_entries_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_access_entries" ADD CONSTRAINT "client_access_entries_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_access_entries_org_client" ON "client_access_entries" USING btree ("organisation_id","client_id");