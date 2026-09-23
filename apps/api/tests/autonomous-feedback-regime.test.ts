import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousAnalyticsFeedbackProvider } from "../src/domain/autonomous-feedback.js";

test("classifies a strong positive incremental period as rising", async () => {
  const overview:any={campaigns:[{campaignId:"c",productId:"p",marketplaceId:"m",clickCount:60,trackingLinkCount:1,contentCount:1,publishedContentCount:1,scheduledContentCount:0,attributedConversionCount:8,attributedRevenueCents:1000,attributedCommissionCents:200,conversionRate:8/60}]};
  const memory:any={latestByProductAndMarketplace:async()=>({productId:"p",marketplaceId:"m",clickCount:20,conversionCount:0,commissionPerClickCents:1,conversionRate:0.02}),saveIfAbsent:async(s:any)=>s};
  const signal=(await new AutonomousAnalyticsFeedbackProvider({overview:async()=>overview},memory).getSignals()).get("m:p");
  assert.equal(signal?.regime,"rising");
});
test("does not classify low-evidence movement as a regime", async () => {
  const overview:any={campaigns:[{campaignId:"c",productId:"p",marketplaceId:"m",clickCount:30,trackingLinkCount:1,contentCount:1,publishedContentCount:1,scheduledContentCount:0,attributedConversionCount:2,attributedRevenueCents:1000,attributedCommissionCents:200,conversionRate:2/30}]};
  const memory:any={latestByProductAndMarketplace:async()=>({productId:"p",marketplaceId:"m",clickCount:20,conversionCount:0,commissionPerClickCents:1,conversionRate:0.02}),saveIfAbsent:async(s:any)=>s};
  const signal=(await new AutonomousAnalyticsFeedbackProvider({overview:async()=>overview},memory).getSignals()).get("m:p");
  assert.equal(signal?.regime,"stable");
});
