CREATE TYPE "public"."goal_kind" AS ENUM('keep', 'spend');--> statement-breakpoint
CREATE TYPE "public"."goal_recurrence" AS ENUM('once', 'yearly');--> statement-breakpoint
CREATE TYPE "public"."goal_status" AS ENUM('active', 'done');--> statement-breakpoint
CREATE TABLE "goal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "goal_kind" NOT NULL,
	"recurrence" "goal_recurrence" DEFAULT 'once' NOT NULL,
	"target_cents" integer,
	"target_date" date,
	"account_id" uuid,
	"priority" integer NOT NULL,
	"is_emergency" boolean DEFAULT false NOT NULL,
	"emergency_months" integer,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"status" "goal_status" DEFAULT 'active' NOT NULL,
	"done_at" timestamp with time zone,
	"prev_goal_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_emergency_check" CHECK (not "goal"."is_emergency" or ("goal"."kind" = 'keep' and "goal"."recurrence" = 'once' and "goal"."target_cents" is null and "goal"."emergency_months" between 1 and 24 and "goal"."status" = 'active')),
	CONSTRAINT "goal_non_emergency_check" CHECK ("goal"."is_emergency" or ("goal"."target_cents" > 0 and "goal"."emergency_months" is null)),
	CONSTRAINT "goal_yearly_check" CHECK ("goal"."recurrence" = 'once' or ("goal"."kind" = 'spend' and "goal"."target_date" is not null)),
	CONSTRAINT "goal_done_at_check" CHECK (("goal"."status" = 'done') = ("goal"."done_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "transaction_split" ADD COLUMN "goal_id" uuid;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_account_id_financial_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_prev_goal_id_goal_id_fk" FOREIGN KEY ("prev_goal_id") REFERENCES "public"."goal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goal_household_id_status_idx" ON "goal" USING btree ("household_id","status");--> statement-breakpoint
CREATE INDEX "goal_account_id_idx" ON "goal" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goal_household_id_emergency_unique" ON "goal" USING btree ("household_id") WHERE "goal"."is_emergency";--> statement-breakpoint
ALTER TABLE "transaction_split" ADD CONSTRAINT "transaction_split_goal_id_goal_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goal"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_split_goal_id_idx" ON "transaction_split" USING btree ("goal_id");