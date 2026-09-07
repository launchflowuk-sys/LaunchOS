-- Which published item a share was spun out of.
--
-- A blog post fans out to a Facebook post and a GBP update pointing back at it.
-- This column is what stops that happening twice, and what lets the monthly
-- allowance ignore the shares: the client paid for the article being written,
-- not for it being posted.
--
-- Null for everything written before, and for anything anybody plans by hand.
ALTER TABLE "content_items" ADD COLUMN "source_item_id" uuid;