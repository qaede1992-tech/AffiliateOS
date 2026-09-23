import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousAnalyticsFeedbackProvider } from "../src/domain/autonomous-feedback.js";

const campaign:any={campaignId:"c",productId:"p",marketplaceId:"m",clickCount:100,trackingLinkCount:1,contentCount:1,publishedContentCount:1,scheduledContentCount:0,attributedConversionCount:20,attributedRevenueCents:10000,attributedCommissionCents:1000,conversionRate:.2};
const base={latestByProductAndMarketplace:async()=>undefined,saveIfAbsent:async(s:any)=>s};
test("large multi-window conversion shift is halted",async()=>{
 const memory:any={...base,recentByProductAndMarketplace:async()=>[
  {clickCount:100,conversionCount:1,observedAt:"2026-08-25T00:00:00Z"},
  {clickCount:100,conversionCount:20,observedAt:"2026-09-22T00:00:00Z"}
 ]};
 const signal=(await new AutonomousAnalyticsFeedbackProvider({overview:async()=>({campaigns:[campaign]})},memory,()=>new Date("2026-09-23T00:00:00Z")).getSignals()).get("m:p");
 assert.equal(signal?.anomaly,"halt");
 assert.equal(signal?.adjustment,0);
});
