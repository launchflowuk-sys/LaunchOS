CREATE TYPE "public"."proposal_line_kind" AS ENUM('setup', 'monthly', 'one_off');--> statement-breakpoint
CREATE TYPE "public"."proposal_pricing_shape" AS ENUM('monthly_on_delivery', 'setup_plus_monthly', 'one_off');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('draft', 'sent', 'viewed', 'accepted', 'declined', 'expired');--> statement-breakpoint
CREATE TABLE "proposal_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"accepted_name" text NOT NULL,
	"accepted_email" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text,
	"signature_svg" text,
	"document_id" uuid
);
--> statement-breakpoint
CREATE TABLE "proposal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"kind" "proposal_line_kind" NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_pence" integer DEFAULT 0 NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"lead_id" uuid,
	"client_id" uuid,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"scope" jsonb DEFAULT '{"deliverables":[],"outOfScope":[],"timeline":""}'::jsonb NOT NULL,
	"pricing" jsonb DEFAULT '{"shape":"monthly_on_delivery","setupPence":0,"monthlyPence":0,"oneOffPence":0,"currency":"GBP","vatNote":""}'::jsonb NOT NULL,
	"terms" text,
	"valid_until" date,
	"status" "proposal_status" DEFAULT 'draft' NOT NULL,
	"sent_at" timestamp with time zone,
	"first_viewed_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"public_token" text NOT NULL,
	"document_id" uuid,
	"package_id" uuid,
	"created_by_user_id" text,
	CONSTRAINT "proposals_lead_or_client" CHECK ("proposals"."lead_id" is not null or "proposals"."client_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "proposal_acceptances" ADD CONSTRAINT "proposal_acceptances_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_acceptances" ADD CONSTRAINT "proposal_acceptances_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_acceptances" ADD CONSTRAINT "proposal_acceptances_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_lines" ADD CONSTRAINT "proposal_lines_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_lines" ADD CONSTRAINT "proposal_lines_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_acceptances_proposal" ON "proposal_acceptances" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "proposal_acceptances_org" ON "proposal_acceptances" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "proposal_lines_proposal_sort" ON "proposal_lines" USING btree ("proposal_id","sort");--> statement-breakpoint
CREATE INDEX "proposal_lines_org" ON "proposal_lines" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_org_reference" ON "proposals" USING btree ("organisation_id","reference");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_public_token" ON "proposals" USING btree ("public_token");--> statement-breakpoint
CREATE INDEX "proposals_org_status_created" ON "proposals" USING btree ("organisation_id","status","created_at");--> statement-breakpoint
CREATE INDEX "proposals_org_client" ON "proposals" USING btree ("organisation_id","client_id");--> statement-breakpoint
CREATE INDEX "proposals_org_lead" ON "proposals" USING btree ("organisation_id","lead_id");