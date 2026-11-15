ALTER TYPE "public"."bank" ADD VALUE 'boq' BEFORE 'cash';--> statement-breakpoint
ALTER TYPE "public"."bank" ADD VALUE 'westpac' BEFORE 'cash';--> statement-breakpoint
ALTER TYPE "public"."bank" ADD VALUE 'ing' BEFORE 'cash';--> statement-breakpoint
ALTER TABLE "financial_account" DROP CONSTRAINT "financial_account_number_suffix_check";--> statement-breakpoint
ALTER TABLE "financial_account" ADD COLUMN "statement_name" text;--> statement-breakpoint
ALTER TABLE "financial_account" ADD CONSTRAINT "financial_account_number_suffix_check" CHECK (case when "financial_account"."bank"::text = 'westpac' then "financial_account"."number_suffix" ~ '^[0-9]{3,5}$' else "financial_account"."number_suffix" ~ '^[0-9]{4,6}$' end);