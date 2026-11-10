import assert from "node:assert/strict";
import test from "node:test";
import { DrizzleAnalyticsReader } from "../src/db/analytics.js";

const campaignId = "00000000-0000-4000-8000-000000000737";

test("single-campaign analytics reads commission from commission_stats", async () => {
  let compiledSql = "";
  const reader = new DrizzleAnalyticsReader({
    execute: async (query: unknown) => {
      compiledSql = (query as { toQuery: (config: any) => { sql: string } }).toQuery({
        casing: undefined,
        escapeName: (name: string) => `"${name.replace(/"/g, '""')}"`,
        escapeParam: (index: number) => `$${index + 1}`,
        escapeString: (value: string) => `'${value.replace(/'/g, "''")}'`,
        prepareTyping: () => undefined
      }).sql;

      return [{
        campaign_id: campaignId,
        click_count: 1,
        tracking_link_count: 1,
        content_count: 0,
        published_content_count: 0,
        scheduled_content_count: 0,
        attributed_conversion_count: 1,
        attributed_revenue_cents: 12_500,
        attributed_commission_cents: 1_250
      }];
    }
  });

  const result = await reader.campaign(campaignId);

  assert.equal(result.attributedCommissionCents, 1_250);
  assert.match(
    compiledSql,
    /COALESCE\(ms\.attributed_commission_cents, 0\) AS attributed_commission_cents/
  );
  assert.doesNotMatch(compiledSql, /ast\.attributed_commission_cents/);
});
