-- Numbers an inbound message must never turn into a lead.
--
-- A message channel Shoji advertises will also carry his family, his drivers
-- and his existing clients. Everything downstream of a lead is machinery, and
-- none of it should start because his wife texted.
--
-- The unique index is per organisation and on the E.164 form, so the same
-- number cannot be added twice under two spellings.
CREATE TABLE "lead_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"note" text,
	"added_by_user_id" text
);
--> statement-breakpoint
ALTER TABLE "lead_suppressions" ADD CONSTRAINT "lead_suppressions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lead_suppressions_org_phone" ON "lead_suppressions" USING btree ("organisation_id","phone");