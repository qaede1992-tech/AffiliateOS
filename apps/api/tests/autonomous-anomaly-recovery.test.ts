import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousAnalyticsFeedbackProvider } from "../src/domain/autonomous-feedback.js";

test("anomaly recovery requires fresh clicks after cooldown",async()=>{
 const now=new Date("2026-01-02T00:00:00.000Z");
 const analytics:any={overview:async()=>({campaigns:[{campaignId:"c",productId:"p",marketplaceId:"m",clickCount:110,trackingLinkCount:1,contentCount:1,publishedContentCount:1,scheduledContentCount:0,attributedConversionCount:2,attributedRevenueCents:0,attributedCommissionCents:0,conversionRate:2/110}]})};
 const halt={id:"h",observationKey:"x",productId:"p",marketplaceId:"m",clickCount:100,conversionCount:30,attributedCommissionCents:0,commissionPerClickCents:0,conversionRate:.3,adjustment:8,anomaly:"halt",anomalyScore:1,observedAt:"2026-01-01T00:00:00.000Z"};
 const memory:any={latestByProductAndMarketplace:async()=>halt,recentByProductAndMarketplace:async()=>[halt],saveIfAbsent:async(s:any)=>s};
 const provider=new AutonomousAnalyticsFeedbackProvider(analytics,memory,()=>now);
 const signals=await provider.getSignals({observationKey:"recovery"});
 assert.equal(signals.get("m:p")?.anomaly,"halt");
});


test("anomaly recovery requires stable post-halt performance evidence",async()=>{
 const now=new Date("2026-01-02T00:00:00.000Z");
 const analytics:any={overview:async()=>({campaigns:[{campaignId:"c",productId:"p",marketplaceId:"m",clickCount:140,trackingLinkCount:1,contentCount:1,publishedContentCount:1,scheduledContentCount:0,attributedConversionCount:22,attributedRevenueCents:0,attributedCommissionCents:0,conversionRate:22/140}]})};
 const halt={id:"h",observationKey:"x",productId:"p",marketplaceId:"m",clickCount:100,conversionCount:12,attributedCommissionCents:0,commissionPerClickCents:0,conversionRate:.12,adjustment:8,anomaly:"halt",anomalyScore:1,observedAt:"2026-01-01T00:00:00.000Z"};
 const followUp={...halt,id:"f",clickCount:120,conversionCount:16,conversionRate:16/120,anomaly:"none",anomalyScore:0,recoveryEvidenceScore:0.8,observedAt:"2026-01-01T12:00:00.000Z"};
 const followUp2={...followUp,id:"f2",clickCount:130,conversionCount:18,conversionRate:18/130,observedAt:"2026-01-01T18:00:00.000Z"};
 const followUp3={...followUp,id:"f3",clickCount:135,conversionCount:20,conversionRate:20/135,observedAt:"2026-01-01T23:00:00.000Z"};
 const memory:any={latestByProductAndMarketplace:async()=>halt,recentByProductAndMarketplace:async()=>[halt,followUp,followUp2,followUp3]};
 const provider=new AutonomousAnalyticsFeedbackProvider(analytics,memory,()=>now);
 const signals=await provider.getSignals({observationKey:"recovery-stable"});
 assert.equal(signals.get("m:p")?.anomaly,"none");
 assert.equal(signals.get("m:p")?.anomalyRecovery,"recovered");
});


test("recovery state is retained in feedback snapshots",async()=>{
 const now=new Date("2026-01-02T00:00:00.000Z");
 const analytics:any={overview:async()=>({campaigns:[{campaignId:"c",productId:"p",marketplaceId:"m",clickCount:140,trackingLinkCount:1,contentCount:1,publishedContentCount:1,scheduledContentCount:0,attributedConversionCount:22,attributedRevenueCents:0,attributedCommissionCents:0,conversionRate:22/140}]})};
 const halt={id:"h",observationKey:"x",productId:"p",marketplaceId:"m",clickCount:100,conversionCount:12,attributedCommissionCents:0,commissionPerClickCents:0,conversionRate:.12,adjustment:8,anomaly:"halt",anomalyScore:1,observedAt:"2026-01-01T00:00:00.000Z"};
 const followUp={...halt,id:"f",clickCount:120,conversionCount:16,conversionRate:16/120,anomaly:"none",anomalyScore:0,recoveryEvidenceScore:0.8,observedAt:"2026-01-01T12:00:00.000Z"};
 const followUp2={...followUp,id:"f2",clickCount:130,conversionCount:18,conversionRate:18/130,observedAt:"2026-01-01T18:00:00.000Z"};
 const followUp3={...followUp,id:"f3",clickCount:135,conversionCount:20,conversionRate:20/135,observedAt:"2026-01-01T23:00:00.000Z"};
 const snapshots:any[]=[];
 const memory:any={latestByProductAndMarketplace:async()=>halt,recentByProductAndMarketplace:async()=>[halt,followUp,followUp2,followUp3],saveIfAbsent:async(s:any)=>{snapshots.push(s);return s}};
 const provider=new AutonomousAnalyticsFeedbackProvider(analytics,memory,()=>now);
 await provider.getSignals({observationKey:"recovery-persisted"});
 assert.equal(snapshots[0]?.recoveryState,"recovered");
 assert.equal(typeof snapshots[0]?.recoveryClicks,"number");
 assert.equal(typeof snapshots[0]?.recoveryEvidenceScore,"number");
});


test("recovered state has hysteresis against a single post-recovery watch signal",async()=>{
 const now=new Date("2026-01-03T00:00:00.000Z");
 const analytics:any={overview:async()=>({campaigns:[{campaignId:"c",productId:"p",marketplaceId:"m",clickCount:160,trackingLinkCount:1,contentCount:1,publishedContentCount:1,scheduledContentCount:0,attributedConversionCount:30,attributedRevenueCents:0,attributedCommissionCents:0,conversionRate:30/160}]})};
 const halt={id:"h",productId:"p",marketplaceId:"m",clickCount:100,conversionCount:10,attributedCommissionCents:0,commissionPerClickCents:0,conversionRate:.1,adjustment:0,anomaly:"halt",anomalyScore:1,observedAt:"2026-01-01T00:00:00.000Z"};
 const recovered={...halt,id:"r",clickCount:140,conversionCount:25,anomaly:"none",anomalyScore:0,recoveryState:"recovered",recoveryEvidenceScore:.9,observedAt:"2026-01-02T00:00:00.000Z"};
 const memory:any={latestByProductAndMarketplace:async()=>recovered,recentByProductAndMarketplace:async()=>[halt,recovered],saveIfAbsent:async(s:any)=>s};
 const provider=new AutonomousAnalyticsFeedbackProvider(analytics,memory,()=>now);
 const signal=(await provider.getSignals()).get("m:p");
 assert.equal(signal?.anomalyRecovery,"recovered");
});


test("recovery signals retain a stable episode identity",async()=>{
 const now=new Date("2026-01-02T00:00:00.000Z");
 const analytics:any={overview:async()=>({campaigns:[{campaignId:"c",productId:"p",marketplaceId:"m",clickCount:140,trackingLinkCount:1,contentCount:1,publishedContentCount:1,scheduledContentCount:0,attributedConversionCount:22,attributedRevenueCents:0,attributedCommissionCents:0,conversionRate:22/140}]})};
 const halt={id:"episode-halt-1",productId:"p",marketplaceId:"m",clickCount:100,conversionCount:12,attributedCommissionCents:0,commissionPerClickCents:0,conversionRate:.12,adjustment:8,anomaly:"halt",anomalyScore:1,observedAt:"2026-01-01T00:00:00.000Z"};
 const followUp={...halt,id:"f",clickCount:120,conversionCount:16,conversionRate:16/120,anomaly:"none",anomalyScore:0,recoveryEvidenceScore:.8,observedAt:"2026-01-01T12:00:00.000Z"};
 const followUp2={...followUp,id:"f2",clickCount:130,conversionCount:18,conversionRate:18/130,observedAt:"2026-01-01T18:00:00.000Z"};
 const followUp3={...followUp,id:"f3",clickCount:135,conversionCount:20,conversionRate:20/135,observedAt:"2026-01-01T23:00:00.000Z"};
 const memory:any={latestByProductAndMarketplace:async()=>halt,recentByProductAndMarketplace:async()=>[halt,followUp,followUp2,followUp3],saveIfAbsent:async(s:any)=>s};
 const provider=new AutonomousAnalyticsFeedbackProvider(analytics,memory,()=>now);
 const signal=(await provider.getSignals()).get("m:p");
 assert.equal(signal?.anomalyRecovery,"recovered");
 assert.equal(signal?.recoveryEpisodeId,"episode-halt-1");
});


test("recovery episode closes after a recovered snapshot",async()=>{
 const now=new Date("2026-01-03T00:00:00.000Z");
 const analytics:any={overview:async()=>({campaigns:[{campaignId:"c",productId:"p",marketplaceId:"m",clickCount:180,trackingLinkCount:1,contentCount:1,publishedContentCount:1,scheduledContentCount:0,attributedConversionCount:36,attributedRevenueCents:0,attributedCommissionCents:0,conversionRate:.2}]})};
 const halt={id:"episode-1",productId:"p",marketplaceId:"m",clickCount:100,conversionCount:10,attributedCommissionCents:0,commissionPerClickCents:0,conversionRate:.1,adjustment:0,anomaly:"halt",anomalyScore:1,recoveryState:"recovering",recoveryEvidenceScore:0,observedAt:"2026-01-01T00:00:00.000Z"};
 const recovered={...halt,id:"recovered-1",clickCount:150,conversionCount:30,conversionRate:.2,anomaly:"none",anomalyScore:0,recoveryState:"recovered",recoveryEvidenceScore:.9,recoveryEpisodeId:"episode-1",observedAt:"2026-01-02T00:00:00.000Z"};
 const memory:any={latestByProductAndMarketplace:async()=>recovered,recentByProductAndMarketplace:async()=>[halt,recovered],saveIfAbsent:async(s:any)=>s};
 const provider=new AutonomousAnalyticsFeedbackProvider(analytics,memory,()=>now);
 const signal=(await provider.getSignals()).get("m:p");
 assert.equal(signal?.anomalyRecovery,"none");
 assert.equal(signal?.recoveryEpisodeId,undefined);
});
