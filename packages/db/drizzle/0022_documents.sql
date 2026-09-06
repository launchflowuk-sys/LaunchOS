CREATE TYPE "public"."document_kind" AS ENUM('proposal', 'proposal_signed', 'delivery_report', 'invoice', 'monthly_report', 'other');--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"client_id" uuid,
	"kind" "document_kind" NOT NULL,
	"title" text NOT NULL,
	"reference" text NOT NULL,
	"path" text NOT NULL,
	"mime" text DEFAULT 'application/pdf' NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"created_by_user_id" text
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_org_client" ON "documents" USING btree ("organisation_id","client_id");--> statement-breakpoint
CREATE INDEX "documents_org_subject" ON "documents" USING btree ("organisation_id","subject_type","subject_id");