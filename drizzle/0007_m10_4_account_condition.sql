CREATE TYPE "public"."condition_outcome" AS ENUM('bonus', 'fee_waiver');--> statement-breakpoint
CREATE TYPE "public"."condition_type" AS ENUM('min_deposit', 'no_withdrawal', 'balance_growth', 'linked_min_deposit', 'linked_card_count', 'other');--> statement-breakpoint
CREATE TYPE "public"."deposit_filter" AS ENUM('any', 'exclude_linked');--> statement-breakpoint
CREATE TABLE "account_condition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"type" "condition_type" NOT NULL,
	"outcome" "condition_outcome" NOT NULL,
	"amount_cents" integer,
	"deposit_filter" "deposit_filter",
	"card_count" integer,
	"description" text,
	"effective_from" date NOT NULL,
	"disabled_from" date,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_condition_months_check" CHECK (extract(day from "account_condition"."effective_from") = 1 and ("account_condition"."disabled_from" is null or (extract(day from "account_condition"."disabled_from") = 1 and "account_condition"."disabled_from" >= "account_condition"."effective_from"))),
	CONSTRAINT "account_condition_params_check" CHECK (coalesce(case "account_condition"."type"
        when 'min_deposit' then "account_condition"."amount_cents" > 0 and "account_condition"."deposit_filter" is not null and "account_condition"."card_count" is null and "account_condition"."description" is null
        when 'linked_min_deposit' then "account_condition"."amount_cents" > 0 and "account_condition"."deposit_filter" is not null and "account_condition"."card_count" is null and "account_condition"."description" is null
        when 'linked_card_count' then "account_condition"."card_count" >= 1 and "account_condition"."amount_cents" is null and "account_condition"."deposit_filter" is null and "account_condition"."description" is null
        when 'other' then "account_condition"."description" is not null and "account_condition"."amount_cents" is null and "account_condition"."deposit_filter" is null and "account_condition"."card_count" is null
        else "account_condition"."amount_cents" is null and "account_condition"."deposit_filter" is null and "account_condition"."card_count" is null and "account_condition"."description" is null
      end, false))
);
--> statement-breakpoint
CREATE TABLE "account_condition_check" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"condition_id" uuid NOT NULL,
	"month" date NOT NULL,
	"is_met" boolean NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_condition_check_condition_id_month_unique" UNIQUE("condition_id","month"),
	CONSTRAINT "account_condition_check_month_check" CHECK (extract(day from "account_condition_check"."month") = 1)
);
--> statement-breakpoint
ALTER TABLE "account_condition" ADD CONSTRAINT "account_condition_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_condition" ADD CONSTRAINT "account_condition_account_id_financial_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_condition" ADD CONSTRAINT "account_condition_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_condition_check" ADD CONSTRAINT "account_condition_check_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_condition_check" ADD CONSTRAINT "account_condition_check_condition_id_account_condition_id_fk" FOREIGN KEY ("condition_id") REFERENCES "public"."account_condition"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_condition_check" ADD CONSTRAINT "account_condition_check_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_condition_account_id_idx" ON "account_condition" USING btree ("account_id");