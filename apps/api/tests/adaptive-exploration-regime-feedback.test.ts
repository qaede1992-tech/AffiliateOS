import assert from "node:assert/strict";
import test from "node:test";
import { AdaptiveExplorationPolicyProvider } from "../src/domain/adaptive-exploration-policy.js";

const candidate={product:{id:"p",marketplaceId:"m",category:"electronics",status:"active"},offers:[]};
test("historical rising regimes reduce exploration",async()=>{
 const state:any={id:"s",marketplaceId:"m",dimension:"category",dimensionKey:"electronics",sampleCount:10,promotedCount:6,deprioritizedCount:0,optimizationPositiveCount:0,optimizationNegativeCount:0,risingCount:8,stableCount:1,decliningCount:1,volatileCount:0,observedAt:"2026-09-23T00:00:00Z"};
 const repo:any={applyEvaluatedAudits:async()=>{},applyOptimizationFeedback:async()=>{},listByMarketplaces:async()=>[state]};
 const p=new AdaptiveExplorationPolicyProvider({list:async()=>[]}, {maximumRate:0.5},repo);
 const rates=await p.getRates([candidate],{explorationRate:0.2});
 assert.equal(rates.get("p"),0.16);
});
test("historical declining regimes increase exploration",async()=>{
 const state:any={id:"s",marketplaceId:"m",dimension:"category",dimensionKey:"electronics",sampleCount:10,promotedCount:0,deprioritizedCount:6,optimizationPositiveCount:0,optimizationNegativeCount:0,risingCount:1,stableCount:1,decliningCount:6,volatileCount:2,observedAt:"2026-09-23T00:00:00Z"};
 const repo:any={applyEvaluatedAudits:async()=>{},applyOptimizationFeedback:async()=>{},listByMarketplaces:async()=>[state]};
 const p=new AdaptiveExplorationPolicyProvider({list:async()=>[]},{maximumRate:0.5},repo);
 const rates=await p.getRates([candidate],{explorationRate:0.2});
 assert.equal(rates.get("p"),0.25);
});
