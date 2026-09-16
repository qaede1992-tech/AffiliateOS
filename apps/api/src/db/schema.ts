import { integer, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
};

export const affiliates = pgTable("affiliates", {
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  email: varchar("email", { length: 320 }).notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  ...timestamps
});

export const offers = pgTable("offers", {
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  commissionRateBps: integer("commission_rate_bps").notNull(),
  ...timestamps
});

export const conversions = pgTable("conversions", {
  id: uuid("id").primaryKey(),
  affiliateId: uuid("affiliate_id").notNull().references(() => affiliates.id),
  offerId: uuid("offer_id").notNull().references(() => offers.id),
  amountCents: integer("amount_cents").notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull()
});

export const commissions = pgTable("commissions", {
  id: uuid("id").primaryKey(),
  conversionId: uuid("conversion_id").notNull().references(() => conversions.id),
  affiliateId: uuid("affiliate_id").notNull().references(() => affiliates.id),
  amountCents: integer("amount_cents").notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  ...timestamps
});