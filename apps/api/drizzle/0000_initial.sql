CREATE TABLE "affiliates" (
  "id" uuid PRIMARY KEY NOT NULL,
  "name" varchar(200) NOT NULL,
  "email" varchar(320) NOT NULL,
  "status" varchar(20) NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "name" varchar(200) NOT NULL,
  "status" varchar(20) NOT NULL,
  "commission_rate_bps" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "affiliate_id" uuid NOT NULL,
  "offer_id" uuid NOT NULL,
  "amount_cents" integer NOT NULL,
  "status" varchar(20) NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commissions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "conversion_id" uuid NOT NULL,
  "affiliate_id" uuid NOT NULL,
  "amount_cents" integer NOT NULL,
  "status" varchar(20) NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_affiliate_id_affiliates_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliates"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_conversion_id_conversions_id_fk" FOREIGN KEY ("conversion_id") REFERENCES "public"."conversions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_affiliate_id_affiliates_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliates"("id") ON DELETE no action ON UPDATE no action;