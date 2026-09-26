CREATE TYPE "public"."infra_provider" AS ENUM('hetzner_cloud', 'coolify');--> statement-breakpoint
CREATE TABLE "infra_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"provider" "infra_provider" NOT NULL,
	"label" text NOT NULL,
	"base_url" text,
	"token_encrypted" text NOT NULL,
	"server_id" uuid,
	"last_synced_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"hetzner_id" bigint NOT NULL,
	"name" text NOT NULL,
	"server_type" text NOT NULL,
	"location" text NOT NULL,
	"ipv4" text,
	"status" text NOT NULL,
	"delete_protected" boolean DEFAULT false NOT NULL,
	"backups_enabled" boolean DEFAULT false NOT NULL,
	"included_traffic_bytes" bigint DEFAULT 0 NOT NULL,
	"outgoing_traffic_bytes" bigint DEFAULT 0 NOT NULL,
	"business" "cost_business" DEFAULT 'shared' NOT NULL,
	"metrics" jsonb,
	"cost" jsonb,
	"pending_action" jsonb,
	"hetzner_created_at" timestamp with time zone NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "infra_connections" ADD CONSTRAINT "infra_connections_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_connection_id_infra_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."infra_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "infra_connections_label" ON "infra_connections" USING btree ("organisation_id","label");--> statement-breakpoint
CREATE INDEX "infra_connections_provider" ON "infra_connections" USING btree ("organisation_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "servers_external" ON "servers" USING btree ("organisation_id","connection_id","hetzner_id");--> statement-breakpoint
CREATE INDEX "servers_ipv4" ON "servers" USING btree ("organisation_id","ipv4");