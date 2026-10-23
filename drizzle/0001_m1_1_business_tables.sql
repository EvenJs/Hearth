CREATE TYPE "public"."account_type" AS ENUM('everyday', 'savings', 'credit_card', 'joint', 'cash');--> statement-breakpoint
CREATE TYPE "public"."bank" AS ENUM('anz', 'anz_plus', 'cba', 'cash', 'other');--> statement-breakpoint
CREATE TYPE "public"."category_kind" AS ENUM('expense', 'income', 'system');--> statement-breakpoint
CREATE TYPE "public"."member_kind" AS ENUM('person', 'shared', 'child');--> statement-breakpoint
CREATE TYPE "public"."rule_match_type" AS ENUM('contains', 'starts_with');--> statement-breakpoint
CREATE TYPE "public"."system_category_key" AS ENUM('internal_transfer', 'cash_withdrawal', 'bank_fee', 'uncategorized');--> statement-breakpoint
CREATE TYPE "public"."transaction_source" AS ENUM('csv', 'manual', 'receipt');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('pending', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."transfer_status" AS ENUM('none', 'auto', 'suggested', 'confirmed');--> statement-breakpoint
CREATE TABLE "budget" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"monthly_limit_cents" integer NOT NULL,
	"warn_at_percent" integer DEFAULT 80 NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_household_id_category_id_unique" UNIQUE("household_id","category_id"),
	CONSTRAINT "budget_monthly_limit_cents_positive" CHECK ("budget"."monthly_limit_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "card" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"last4" char(4) NOT NULL,
	"member_id" uuid NOT NULL,
	"label" text,
	CONSTRAINT "card_account_id_last4_unique" UNIQUE("account_id","last4")
);
--> statement-breakpoint
CREATE TABLE "category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"parent_id" uuid,
	"name_zh" text,
	"name_en" text NOT NULL,
	"kind" "category_kind" NOT NULL,
	"system_key" "system_category_key",
	"default_member_id" uuid,
	"is_pre_tax_default" boolean DEFAULT false NOT NULL,
	"is_other" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	CONSTRAINT "category_household_id_parent_id_name_en_unique" UNIQUE NULLS NOT DISTINCT("household_id","parent_id","name_en")
);
--> statement-breakpoint
CREATE TABLE "category_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"keyword" text NOT NULL,
	"match_type" "rule_match_type" DEFAULT 'contains' NOT NULL,
	"category_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_rule_household_id_keyword_match_type_unique" UNIQUE("household_id","keyword","match_type")
);
--> statement-breakpoint
CREATE TABLE "financial_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"bank" "bank" NOT NULL,
	"type" "account_type" NOT NULL,
	"default_member_id" uuid NOT NULL,
	"number_suffix" varchar(6),
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_account_household_id_name_unique" UNIQUE("household_id","name"),
	CONSTRAINT "financial_account_number_suffix_check" CHECK ("financial_account"."number_suffix" ~ '^[0-9]{4,6}$')
);
--> statement-breakpoint
CREATE TABLE "household" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "household_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_user_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "import_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"date_from" date NOT NULL,
	"date_to" date NOT NULL,
	"row_count" integer NOT NULL,
	"inserted_count" integer NOT NULL,
	"duplicate_count" integer NOT NULL,
	"matched_pending_count" integer NOT NULL,
	"opening_balance_cents" integer,
	"closing_balance_cents" integer,
	"reconciled" boolean,
	"warnings" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "member_kind" NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_household_id_name_unique" UNIQUE("household_id","name")
);
--> statement-breakpoint
CREATE TABLE "tax_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"financial_year" smallint NOT NULL,
	"payg_gross_cents" integer DEFAULT 0 NOT NULL,
	"payg_withheld_cents" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_profile_member_id_financial_year_unique" UNIQUE("member_id","financial_year")
);
--> statement-breakpoint
CREATE TABLE "transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"date" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"raw_description" text NOT NULL,
	"merchant" text NOT NULL,
	"card_last4" char(4),
	"balance_cents" integer,
	"status" "transaction_status" NOT NULL,
	"source" "transaction_source" NOT NULL,
	"transfer_status" "transfer_status" DEFAULT 'none' NOT NULL,
	"transfer_pair_id" uuid,
	"dedupe_key" text,
	"import_batch_id" uuid,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "transaction_amount_cents_nonzero" CHECK ("transaction"."amount_cents" <> 0)
);
--> statement-breakpoint
CREATE TABLE "transaction_split" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"category_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"category_source" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"member_source" text NOT NULL,
	"is_pre_tax" boolean DEFAULT false NOT NULL,
	"note" text,
	CONSTRAINT "transaction_split_amount_cents_nonzero" CHECK ("transaction_split"."amount_cents" <> 0)
);
--> statement-breakpoint
ALTER TABLE "budget" ADD CONSTRAINT "budget_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget" ADD CONSTRAINT "budget_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card" ADD CONSTRAINT "card_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card" ADD CONSTRAINT "card_account_id_financial_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card" ADD CONSTRAINT "card_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_parent_id_category_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_default_member_id_member_id_fk" FOREIGN KEY ("default_member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_rule" ADD CONSTRAINT "category_rule_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_rule" ADD CONSTRAINT "category_rule_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_account" ADD CONSTRAINT "financial_account_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_account" ADD CONSTRAINT "financial_account_default_member_id_member_id_fk" FOREIGN KEY ("default_member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_user" ADD CONSTRAINT "household_user_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_user" ADD CONSTRAINT "household_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_user" ADD CONSTRAINT "household_user_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_account_id_financial_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_profile" ADD CONSTRAINT "tax_profile_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_profile" ADD CONSTRAINT "tax_profile_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_account_id_financial_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_transfer_pair_id_transaction_id_fk" FOREIGN KEY ("transfer_pair_id") REFERENCES "public"."transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_import_batch_id_import_batch_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_split" ADD CONSTRAINT "transaction_split_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_split" ADD CONSTRAINT "transaction_split_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_split" ADD CONSTRAINT "transaction_split_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_split" ADD CONSTRAINT "transaction_split_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "category_household_id_system_key_unique" ON "category" USING btree ("household_id","system_key") WHERE "category"."system_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_account_id_dedupe_key_unique" ON "transaction" USING btree ("account_id","dedupe_key") WHERE "transaction"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "transaction_household_id_date_idx" ON "transaction" USING btree ("household_id","date");--> statement-breakpoint
CREATE INDEX "transaction_account_id_date_idx" ON "transaction" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "transaction_household_id_status_idx" ON "transaction" USING btree ("household_id","status");--> statement-breakpoint
CREATE INDEX "transaction_household_id_merchant_idx" ON "transaction" USING btree ("household_id","merchant");--> statement-breakpoint
CREATE INDEX "transaction_split_household_id_category_id_idx" ON "transaction_split" USING btree ("household_id","category_id");--> statement-breakpoint
CREATE INDEX "transaction_split_household_id_member_id_idx" ON "transaction_split" USING btree ("household_id","member_id");--> statement-breakpoint
CREATE INDEX "transaction_split_transaction_id_idx" ON "transaction_split" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_split_transaction_id_primary_unique" ON "transaction_split" USING btree ("transaction_id") WHERE "transaction_split"."is_primary";