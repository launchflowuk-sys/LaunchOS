ALTER TABLE "organisations" ADD COLUMN "bank_account_name" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "bank_sort_code" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "bank_account_number" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "bank_iban" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "reference" text;