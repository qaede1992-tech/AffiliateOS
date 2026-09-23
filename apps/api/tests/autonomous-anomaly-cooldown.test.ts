import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousAnalyticsFeedbackProvider } from "../src/domain/autonomous-feedback.js";

test("recent halt remains active during anomaly cooldown", async()=>{
 const previous:any={id:"old",observationKey:"old",productId:"p",marketplaceId:"m",clickCount:100,conversionCount:10,attributedCommissionCents:100,commissionPerClickCents:1,conversionRate:.1,adjustment:0,anomaly:"halt",anomalyScore:.9,observedAt:"2026-09-23T00:00:00Z"};
 const memory:any={latestByProductAndMarketplace:async()=>previous,saveIfAbsent:async(s:any)=>s,recentByProductAndMarketplace:async()=>[]};
 const overview:any={campaigns:[{campaignId:"c",productId:"p",marketplaceId:"m",clickCount:100,trackingLinkCount:1,contentCount:1,publishedContentCount:1,scheduledContentCount:0,attributedConversionCount:10,attributedRevenueCents:1000,attributedCommissionCents:100,conversionRate:.1}]};
 const signal=(await new AutonomousAnalyticsFeedbackProvider({overview:async()=>overview},memory,()=>new Date("2026-09-23T05:00:00Z")).getSignals()).get("m:p");
 assert.equal(signal?.anomaly,"halt");
});