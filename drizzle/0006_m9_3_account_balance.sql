CREATE TYPE "public"."account_purpose" AS ENUM('everyday', 'bills', 'emergency', 'savings', 'goal');--> statement-breakpoint
CREATE TABLE "account_balance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"date" date NOT NULL,
	"balance_cents" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "financial_account" ADD COLUMN "purpose" "account_purpose" DEFAULT 'everyday' NOT NULL;--> statement-breakpoint
ALTER TABLE "financial_account" ADD COLUMN "linked_account_id" uuid;--> statement-breakpoint
ALTER TABLE "account_balance" ADD CONSTRAINT "account_balance_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_balance" ADD CONSTRAINT "account_balance_account_id_financial_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_balance" ADD CONSTRAINT "account_balance_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_balance_account_id_date_idx" ON "account_balance" USING btree ("account_id","date");--> statement-breakpoint
ALTER TABLE "financial_account" ADD CONSTRAINT "financial_account_linked_account_id_financial_account_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."financial_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_account" ADD CONSTRAINT "financial_account_linked_account_id_check" CHECK ("financial_account"."linked_account_id" <> "financial_account"."id");