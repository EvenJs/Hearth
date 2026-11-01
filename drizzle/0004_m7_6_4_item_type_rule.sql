CREATE TYPE "public"."item_type" AS ENUM('fruit', 'vegetable', 'meat', 'seafood', 'dairy_egg', 'pantry', 'snack', 'drink', 'household', 'other');--> statement-breakpoint
CREATE TABLE "item_type_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name_key" text NOT NULL,
	"item_type" "item_type" NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_type_rule_household_id_name_key_unique" UNIQUE("household_id","name_key")
);
--> statement-breakpoint
ALTER TABLE "item_type_rule" ADD CONSTRAINT "item_type_rule_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_type_rule" ADD CONSTRAINT "item_type_rule_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;