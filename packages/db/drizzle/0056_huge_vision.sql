ALTER TYPE "public"."usage_product" ADD VALUE 'fee';--> statement-breakpoint
ALTER TYPE "public"."usage_source" ADD VALUE 'processor_fee' BEFORE 'other';