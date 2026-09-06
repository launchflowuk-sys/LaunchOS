ALTER TABLE "packages" ADD COLUMN "stripe_product_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "stripe_price_id" text;--> statement-breakpoint
CREATE INDEX "packages_org_stripe_product" ON "packages" USING btree ("organisation_id","stripe_product_id");