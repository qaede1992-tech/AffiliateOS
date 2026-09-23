import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousAnalyticsFeedbackProvider } from "../src/domain/autonomous-feedback.js";

test("anomaly recovery requires fresh clicks after cooldown",async()=>{
 const now=new Date("2026-01-02T00:00:00.000Z");
 const analytics:any={overview:async()=>({campaigns:[{campaignId:"c",productId:"p",marketplaceId:"m",clickCount:110,trackingLinkCount:1,contentCount:1,publishedContentCount:1,scheduledContentCount:0,attributedConversionCount:2,attributedRevenueCents:0,attributedCommissionCents:0,conversionRate:2/110}]})};
 const halt={id:"h",observationKey:"x",productId:"p",marketplaceId:"m",clickCount:100,conversionCount:30,attributedCommissionCents:0,commissionPerClickCents:0,conversionRate:.3,adjustment:8,anomaly:"halt",anomalyScore:1,observedAt:"2026-01-01T00:00:00.000Z"};
 const memory:any={latestByProductAndMarketplace:async()=>halt,recentByProductAndMarketplace:async()=>[halt]};
 const provider=new AutonomousAnalyticsFeedbackProvider(analytics,memory,()=>now);
 const signals=await provider.getSignals({observationKey:"recovery"});
 assert.equal(signals.get("m:p")?.anomaly,"halt");
});


test("anomaly recovery requires stable post-halt performance evidence",async()=>{
 const now=new Date("2026-01-02T00:00:00.000Z");
 const analytics:any={overview:async()=>({campaigns:[{campaignId:"c",productId:"p",marketplaceId:"m",clickCount:140,trackingLinkCount:1,contentCount:1,publishedContentCount:1,scheduledContentCount:0,attributedConversionCount:22,attributedRevenueCents:0,attributedCommissionCents:0,conversionRate:22/140}]})};
 const halt={id:"h",observationKey:"x",productId:"p",marketplaceId:"m",clickCount:100,conversionCount:12,attributedCommissionCents:0,commissionPerClickCents:0,conversionRate:.12,adjustment:8,anomaly:"halt",anomalyScore:1,observedAt:"2026-01-01T00:00:00.000Z"};
 const followUp={...halt,id:"f",clickCount:120,conversionCount:16,conversionRate:16/120,anomaly:"none",anomalyScore:0,observedAt:"2026-01-01T12:00:00.000Z"};
 const memory:any={latestByProductAndMarketplace:async()=>halt,recentByProductAndMarketplace:async()=>[halt,followUp]};
 const provider=new AutonomousAnalyticsFeedbackProvider(analytics,memory,()=>now);
 const signals=await provider.getSignals({observationKey:"recovery-stable"});
 assert.equal(signals.get("m:p")?.anomaly,"none");
 assert.equal(signals.get("m:p")?.anomalyRecovery,"recovered");
});
