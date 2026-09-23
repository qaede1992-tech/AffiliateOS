import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousOptimizationService } from "../src/domain/autonomous-optimization.js";

test("halt anomaly forces autonomous optimization to maintain",async()=>{
 const analytics:any={overview:async()=>({campaigns:[{campaignId:"c",productId:"p",marketplaceId:"m",clickCount:100,trackingLinkCount:1,contentCount:1,publishedContentCount:1,scheduledContentCount:0,attributedConversionCount:10,attributedRevenueCents:10000,attributedCommissionCents:1000,conversionRate:.1}]})};
 const feedback:any={getSignals:async()=>new Map([["m:p",{anomaly:"halt",adjustment:0}]])};
 const service=new AutonomousOptimizationService(analytics,{minClicksForDecision:20,scaleConversionRate:.05},undefined,feedback);
 const result=await service.recommend();
 assert.equal(result.recommendations[0].action,"maintain");
 assert.match(result.recommendations[0].reasons[0],"anomaly");
});
