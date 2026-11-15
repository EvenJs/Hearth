CREATE TABLE "tax_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"employer" text,
	"annual_salary_cents" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_job_salary_check" CHECK ("tax_job"."annual_salary_cents" > 0),
	CONSTRAINT "tax_job_dates_check" CHECK ("tax_job"."end_date" is null or "tax_job"."end_date" >= "tax_job"."start_date")
);
--> statement-breakpoint
ALTER TABLE "tax_profile" ALTER COLUMN "payg_gross_cents" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tax_profile" ALTER COLUMN "payg_gross_cents" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_profile" ALTER COLUMN "payg_withheld_cents" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tax_profile" ALTER COLUMN "payg_withheld_cents" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_profile" ADD COLUMN "expected_interest_cents" integer;--> statement-breakpoint
ALTER TABLE "tax_job" ADD CONSTRAINT "tax_job_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_job" ADD CONSTRAINT "tax_job_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tax_job_household_id_member_id_idx" ON "tax_job" USING btree ("household_id","member_id");