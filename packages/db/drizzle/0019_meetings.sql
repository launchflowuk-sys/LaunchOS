CREATE TYPE "public"."meeting_kind" AS ENUM('discovery', 'review', 'support', 'other');--> statement-breakpoint
CREATE TYPE "public"."meeting_status" AS ENUM('scheduled', 'rescheduled', 'cancelled', 'completed', 'no_show');--> statement-breakpoint
ALTER TYPE "public"."approval_kind" ADD VALUE 'lead_reply';--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"kind" "meeting_kind" DEFAULT 'discovery' NOT NULL,
	"lead_id" uuid,
	"client_id" uuid,
	"host_user_id" text NOT NULL,
	"guest_name" text NOT NULL,
	"guest_email" text NOT NULL,
	"guest_timezone" text DEFAULT 'Europe/London' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "meeting_status" DEFAULT 'scheduled' NOT NULL,
	"provider" text NOT NULL,
	"provider_meeting_id" text,
	"join_url" text NOT NULL,
	"host_url" text,
	"reschedule_token" text NOT NULL,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "client_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "lead_id" uuid;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_host_user_id_user_id_fk" FOREIGN KEY ("host_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meetings_org_starts" ON "meetings" USING btree ("organisation_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_reschedule_token" ON "meetings" USING btree ("reschedule_token");--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_host_live_slot" ON "meetings" USING btree ("host_user_id","starts_at") WHERE "meetings"."status" in ('scheduled', 'rescheduled');--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_org_lead" ON "conversations" USING btree ("organisation_id","lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_pending_lead_reply" ON "approvals" USING btree ("organisation_id",("payload" ->> 'leadId')) WHERE "approvals"."status" = 'pending' and "approvals"."payload" ->> 'action' = 'lead_reply';--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_client_or_lead" CHECK ("conversations"."client_id" is not null or "conversations"."lead_id" is not null);