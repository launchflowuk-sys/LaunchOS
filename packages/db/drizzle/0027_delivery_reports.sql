CREATE TABLE "delivery_sign_offs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"signed_name" text NOT NULL,
	"signed_email" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text,
	"signature_svg" text,
	"document_id" uuid
);
--> statement-breakpoint
ALTER TABLE "delivery_sign_offs" ADD CONSTRAINT "delivery_sign_offs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_sign_offs" ADD CONSTRAINT "delivery_sign_offs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_sign_offs" ADD CONSTRAINT "delivery_sign_offs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_sign_offs_project" ON "delivery_sign_offs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "delivery_sign_offs_org" ON "delivery_sign_offs" USING btree ("organisation_id");--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "delivery_report_document_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "sign_off_token" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "sign_off_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_delivery_report_document_id_documents_id_fk" FOREIGN KEY ("delivery_report_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_sign_off_token" ON "projects" USING btree ("sign_off_token") WHERE "projects"."sign_off_token" is not null;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_reports" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "client_reports" ADD CONSTRAINT "client_reports_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
