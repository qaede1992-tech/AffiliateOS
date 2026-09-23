import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousAnalyticsFeedbackProvider } from "../src/domain/autonomous-feedback.js";

test("multi-window regime confidence is bounded",async()=>{
 const memory:any={latestByProductAndMarketplace:async()=>undefined,recentByProductAndMarketplace:async()=>[
   {clickCount:20,conversionCount:1,observedAt:"2026-09-22T00:00:00Z"}
 ],saveIfAbsent:async(s:any)=>s};
 const overview:any={campaigns:[{campaignId:"c",productId:"p",marketplaceId:"m",clickCount:60,trackingLinkCount:1,contentCount:1,publishedContentCount:1,scheduledContentCount:0,attributedConversionCount:8,attributedRevenueCents:1000,attributedCommissionCents:200,conversionRate:8/60}]};
 const provider=new AutonomousAnalyticsFeedbackProvider({overview:async()=>overview},memory,()=>new Date("2026-09-23T00:00:00Z"));
 const signal=(await provider.getSignals()).get("m:p");
 assert.ok((signal?.regimeConfidence??-1)>=0);
 assert.ok((signal?.regimeConfidence??2)<=1);
});
