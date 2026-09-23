import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousAnalyticsFeedbackProvider } from "../src/domain/autonomous-feedback.js";

function overview(clickCount:number,conversionCount:number){return {campaigns:[{campaignId:"c",productId:"p",marketplaceId:"m",clickCount,trackingLinkCount:1,contentCount:1,publishedContentCount:1,scheduledContentCount:0,attributedConversionCount:conversionCount,attributedRevenueCents:1000,attributedCommissionCents:200,conversionRate:clickCount?conversionCount/clickCount:0}]};}

test("strong short-term improvement is classified as rising",async()=>{
 const memory:any={latestByProductAndMarketplace:async()=>undefined,recentByProductAndMarketplace:async()=>[{clickCount:40,conversionCount:1,observedAt:"2026-09-22T00:00:00Z"}],saveIfAbsent:async(s:any)=>s};
 const p=new AutonomousAnalyticsFeedbackProvider({overview:async()=>overview(100,15)},memory,()=>new Date("2026-09-23T00:00:00Z"));
 const s=(await p.getSignals()).get("m:p");
 assert.equal(s?.regime,"rising"); assert.ok(s?.windows?.["24h"]);
});
test("weak short-term evidence remains stable",async()=>{
 const memory:any={latestByProductAndMarketplace:async()=>undefined,recentByProductAndMarketplace:async()=>[{clickCount:5,conversionCount:0,observedAt:"2026-09-22T00:00:00Z"}],saveIfAbsent:async(s:any)=>s};
 const p=new AutonomousAnalyticsFeedbackProvider({overview:async()=>overview(10,2)},memory,()=>new Date("2026-09-23T00:00:00Z"));
 const s=(await p.getSignals()).get("m:p");
 assert.equal(s?.regime,"stable");
});
