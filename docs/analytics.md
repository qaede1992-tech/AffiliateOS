# Analytics boundary

AffiliateOS analytics are split into two categories until a canonical attribution model is available.

## Attributable operational metrics

The current analytics API derives campaign metrics from the relationships that exist in the tracking domain:

- clicks -> tracking links -> campaigns
- tracking-link counts -> campaigns
- content counts/status -> campaigns

Production reads use PostgreSQL aggregation so totals do not require loading every operational row into the API process.

## Attribution boundary

The legacy `conversions` and `commissions` tables are intentionally not joined to campaign analytics. Legacy conversions reference the legacy `offers` table, while tracking links reference `affiliate_offers`; there is no canonical relationship that safely attributes a legacy conversion to a campaign, product, marketplace, or social account.

Until that domain relationship is explicitly modeled, AffiliateOS must not calculate campaign conversion rate, attributed revenue, or attributed commission from those legacy rows.

Future attribution work should introduce an explicit conversion/order attribution model and then add database-backed aggregates for conversions, orders, revenue, commissions, CTR, conversion rate, and product/marketplace/social breakdowns.
