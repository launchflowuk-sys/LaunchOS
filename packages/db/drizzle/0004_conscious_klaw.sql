CREATE TYPE "public"."task_assignee_role" AS ENUM('owner', 'staff', 'any');--> statement-breakpoint
CREATE TYPE "public"."task_kind" AS ENUM('build', 'deploy', 'dns', 'seo', 'content', 'social', 'gbp', 'review', 'handover', 'support', 'billing', 'other');--> statement-breakpoint
CREATE TYPE "public"."task_phase" AS ENUM('onboarding', 'recurring', 'support');--> statement-breakpoint
CREATE TYPE "public"."task_recurrence" AS ENUM('none', 'weekly', 'monthly', 'quarterly');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('todo', 'in_progress', 'blocked', 'review', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"monthly_price_pence" integer DEFAULT 0 NOT NULL,
	"setup_price_pence" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"includes" jsonb DEFAULT '{"website":false,"seo":false,"ads":false,"socialPostsPerMonth":0,"blogPostsPerMonth":0,"gbpUpdatesPerMonth":0}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"package_id" uuid,
	"phase" "task_phase" NOT NULL,
	"kind" "task_kind" DEFAULT 'other' NOT NULL,
	"title" text NOT NULL,
	"description_md" text,
	"offset_days" integer DEFAULT 0 NOT NULL,
	"recurrence" "task_recurrence" DEFAULT 'none' NOT NULL,
	"default_assignee_role" "task_assignee_role" DEFAULT 'any' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"author_kind" "actor_kind" NOT NULL,
	"author_id" text,
	"body_md" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organisation_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"site_id" uuid,
	"template_id" uuid,
	"phase" "task_phase" NOT NULL,
	"kind" "task_kind" DEFAULT 'other' NOT NULL,
	"title" text NOT NULL,
	"description_md" text,
	"status" "task_status" DEFAULT 'todo' NOT NULL,
	"priority" "task_priority" DEFAULT 'medium' NOT NULL,
	"due_at" timestamp with time zone,
	"assignee_user_id" text,
	"created_by_kind" "actor_kind" DEFAULT 'system' NOT NULL,
	"created_by_id" text,
	"completed_at" timestamp with time zone,
	"ticket_id" uuid,
	"recurrence_key" text,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"client_visible" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "onboarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "handover_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_templates" ADD CONSTRAINT "task_templates_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_templates" ADD CONSTRAINT "task_templates_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_template_id_task_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."task_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "packages_org_slug" ON "packages" USING btree ("organisation_id","slug");--> statement-breakpoint
CREATE INDEX "task_comments_task_created" ON "task_comments" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_client_template_onboarding" ON "tasks" USING btree ("client_id","template_id") WHERE "tasks"."template_id" is not null and "tasks"."phase" = 'onboarding';--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_client_recurrence_key" ON "tasks" USING btree ("client_id","recurrence_key");--> statement-breakpoint
CREATE INDEX "tasks_org_status_due" ON "tasks" USING btree ("organisation_id","status","due_at");--> statement-breakpoint
CREATE INDEX "tasks_org_client_phase" ON "tasks" USING btree ("organisation_id","client_id","phase");--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE set null ON UPDATE no action;