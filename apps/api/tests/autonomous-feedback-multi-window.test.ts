import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousAnalyticsFeedbackProvider } from "../src/domain/autonomous-feedback.js";

test("multi-window learning exposes 24h, 7d and 30d windows", async () => {
  const overview:any = {
    clickCount: 100, trackingLinkCount: 1, campaignCount: 1, contentCount: 1,
    publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 10,
    attributedRevenueCents: 10000, attributedCommissionCents: 1000, conversionRate: 0.1,
    campaigns: [{
      campaignId:"c1",productId:"p1",marketplaceId:"m1",category:"electronics",audienceSegments:["electronics"],
      clickCount:100,trackingLinkCount:1,contentCount:1,publishedContentCount:1,scheduledContentCount:0,
      attributedConversionCount:10,attributedRevenueCents:10000,attributedCommissionCents:1000,conversionRate:0.1
    }]
  };
  const memory:any = {
    latestByProductAndMarketplace: async () => undefined,
    recentByProductAndMarketplace: async (_p:string,_m:string,since:string) => {
      const age=Date.now()-Date.parse(since);
      if (age <= 24*60*60*1000) return [{clickCount:90,conversionCount:9,observedAt:"2026-09-22T00:00:00Z"}];
      if (age <= 7*24*60*60*1000) return [{clickCount:60,conversionCount:3,observedAt:"2026-09-17T00:00:00Z"}];
      return [{clickCount:20,conversionCount:0,observedAt:"2026-08-25T00:00:00Z"}];
    },
    saveIfAbsent: async (s:any)=>s
  };
  const provider=new AutonomousAnalyticsFeedbackProvider({overview:async()=>overview},memory,()=>new Date("2026-09-23T00:00:00Z"));
  const signal=(await provider.getSignals()).get("m1:p1");
  assert.equal(signal?.windows?.["24h"].clickCount,10);
  assert.equal(signal?.windows?.["7d"].clickCount,40);
  assert.equal(signal?.windows?.["30d"].clickCount,80);
});
