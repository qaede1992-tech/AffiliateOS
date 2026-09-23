import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousAnalyticsFeedbackProvider } from "../src/domain/autonomous-feedback.js";

test("recovery episode metrics measure recovery from the halt anchor",async()=>{
 const now=new Date("2026-01-03T00:00:00.000Z");
 const analytics:any={overview:async()=>({campaigns:[{campaignId:"c",productId:"p",marketplaceId:"m",clickCount:140,trackingLinkCount:1,contentCount:1,publishedContentCount:1,scheduledContentCount:0,attributedConversionCount:25,attributedRevenueCents:0,attributedCommissionCents:1250,conversionRate:25/140}]})};
 const halt={id:"episode-1",productId:"p",marketplaceId:"m",clickCount:100,conversionCount:10,attributedCommissionCents:500,commissionPerClickCents:5,conversionRate:.1,adjustment:0,anomaly:"halt",anomalyScore:1,recoveryState:"recovering",recoveryClicks:0,recoveryEvidenceScore:0,observedAt:"2026-01-01T00:00:00.000Z"};
 const memory:any={latestByProductAndMarketplace:async()=>halt,recentByProductAndMarketplace:async()=>[halt],saveIfAbsent:async(s:any)=>s};
 const provider=new AutonomousAnalyticsFeedbackProvider(analytics,memory,()=>now);
 const signal=(await provider.getSignals()).get("m:p");
 assert.equal(signal?.recoveryEpisodeId,"episode-1");
 assert.equal(signal?.recoveryEpisodeMetrics?.recoveryClicks,40);
 assert.equal(signal?.recoveryEpisodeMetrics?.conversionDelta,15);
 assert.equal(signal?.recoveryEpisodeMetrics?.commissionDeltaCents,750);
 assert.equal(signal?.recoveryEpisodeMetrics?.recoveryDurationMs,172800000);
});
