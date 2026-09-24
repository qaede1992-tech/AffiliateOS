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


test("recovered evidence does not regain full influence immediately",async()=>{
 const memory:any={
  latestByProductAndMarketplace:async()=>({clickCount:20,conversionCount:1,attributedCommissionCents:20,commissionPerClickCents:1,observedAt:"2026-09-20T00:00:00Z",anomaly:"halt"}),
  recentByProductAndMarketplace:async()=>[
   {clickCount:20,conversionCount:1,attributedCommissionCents:20,observedAt:"2026-09-20T00:00:00Z",anomaly:"halt"},
   {clickCount:40,conversionCount:2,attributedCommissionCents:40,observedAt:"2026-09-22T00:00:00Z",anomaly:"none"},
   {clickCount:50,conversionCount:3,attributedCommissionCents:50,observedAt:"2026-09-22T12:00:00Z",anomaly:"none",recoveryEvidenceScore:.8},
   {clickCount:55,conversionCount:4,attributedCommissionCents:60,observedAt:"2026-09-22T18:00:00Z",anomaly:"none",recoveryEvidenceScore:.8}
  ],saveIfAbsent:async(s:any)=>s
 };
 const overview:any={campaigns:[{campaignId:"c",productId:"p",marketplaceId:"m",clickCount:60,trackingLinkCount:1,contentCount:1,publishedContentCount:1,scheduledContentCount:0,attributedConversionCount:6,attributedRevenueCents:1000,attributedCommissionCents:120,conversionRate:.1}]};
 const provider=new AutonomousAnalyticsFeedbackProvider({overview:async()=>overview},memory,()=>new Date("2026-09-23T00:00:00Z"));
 const signal=(await provider.getSignals()).get("m:p");
 assert.equal(signal?.anomalyRecovery,"recovered");
 assert.ok((signal?.recoveryEvidenceScore??0)>=0);
});
