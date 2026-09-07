-- How an outbound message travels, so a reply can follow the way the enquiry
-- arrived.
--
-- Everything written before this is email, which is why `channel` defaults
-- rather than being backfilled: the default is the truth for every existing
-- row. `to_phone` is null for all of them and set only when the channel is not
-- email.
--
-- Adding a NOT NULL column with a default does not rewrite the table on
-- PostgreSQL 11 and later, so this is safe on a live messages table.
ALTER TABLE "messages" ADD COLUMN "channel" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "to_phone" text;