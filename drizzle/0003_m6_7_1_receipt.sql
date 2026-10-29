CREATE TABLE "receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"transaction_id" uuid,
	"merchant" text NOT NULL,
	"receipt_date" date NOT NULL,
	"total_cents" integer NOT NULL,
	"parsed_json" jsonb NOT NULL,
	"reader" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_total_cents_positive" CHECK ("receipt"."total_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_transaction_id_unique" ON "receipt" USING btree ("transaction_id") WHERE "receipt"."transaction_id" is not null;--> statement-breakpoint
CREATE INDEX "receipt_household_id_receipt_date_idx" ON "receipt" USING btree ("household_id","receipt_date");