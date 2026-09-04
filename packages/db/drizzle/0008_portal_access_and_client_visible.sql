CREATE TYPE "public"."client_user_status" AS ENUM('active', 'suspended');--> statement-breakpoint
ALTER TABLE "client_users" ADD COLUMN "status" "client_user_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "client_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Existing tickets the client originated are client-facing by definition:
-- they raised them in the portal or sent them by email. Everything else
-- (agent, monitor, manual) stays hidden until staff share it deliberately.
UPDATE "tickets" SET "client_visible" = true WHERE "source" IN ('portal', 'email');
