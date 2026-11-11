CREATE TYPE "public"."invite_purpose" AS ENUM('join', 'new_household');--> statement-breakpoint
CREATE TYPE "public"."llm_usage_purpose" AS ENUM('receipt');--> statement-breakpoint
CREATE TABLE "invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"purpose" "invite_purpose" NOT NULL,
	"household_id" uuid,
	"member_id" uuid,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_by" text,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_code_unique" UNIQUE("code"),
	CONSTRAINT "invite_purpose_check" CHECK (("invite"."purpose" = 'join' and "invite"."household_id" is not null and "invite"."member_id" is not null) or ("invite"."purpose" = 'new_household' and "invite"."household_id" is null and "invite"."member_id" is null)),
	CONSTRAINT "invite_used_check" CHECK (("invite"."used_by" is null) = ("invite"."used_at" is null)),
	CONSTRAINT "invite_used_revoked_check" CHECK ("invite"."used_at" is null or "invite"."revoked_at" is null)
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"purpose" "llm_usage_purpose" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_used_by_user_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invite_created_by_created_at_idx" ON "invite" USING btree ("created_by","created_at");--> statement-breakpoint
CREATE INDEX "llm_usage_household_id_purpose_created_at_idx" ON "llm_usage" USING btree ("household_id","purpose","created_at");--> statement-breakpoint
-- R26.7：现有用户（user:create 建的）都当已验证，开 requireEmailVerification 后照常登录
UPDATE "user" SET "email_verified" = true WHERE "email_verified" = false;
