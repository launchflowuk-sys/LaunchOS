ALTER TABLE "knowledge_articles" ADD COLUMN "audiences" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_articles" ADD COLUMN "routes" text[] DEFAULT '{}' NOT NULL;