import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousOpportunitySelector } from "../src/domain/autonomous-opportunity.js";

test("recovering anomaly heavily damps performance influence",()=>{
 const product:any={id:"p",marketplaceId:"m",status:"active",name:"P",priceCents:1000,currency:"USD",productUrl:"https://example.test/p",category:"x",soldCount:100,reviewCount:10};
 const offer:any={id:"o",productId:"p",status:"active",commissionRateBps:1000,commissionAmountCents:100,affiliateLinkStatus:"active",affiliateUrl:"https://example.test/affiliate"};
 const selector=new AutonomousOpportunitySelector();
 const result=selector.select([{product,offers:[offer]}],{minimumScore:0,maximumResults:1},new Map([["m:p",{clickCount:100,conversionCount:20,conversionRate:.2,attributedCommissionCents:1000,commissionPerClickCents:10,adjustment:8,trendAdjustment:0,anomaly:"none",anomalyRecovery:"recovering",regimeConfidence:1}]]));
 assert.ok(result.selected[0]);
 assert.ok((result.selected[0].breakdown.performanceAdjustment ?? 0) <= 2.1);
});