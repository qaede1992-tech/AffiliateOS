import assert from "node:assert/strict";
import test from "node:test";
test("recovery episode deterioration keeps exploration elevated",async()=>{
 const { AdaptiveExplorationPolicyProvider }=await import("../src/domain/adaptive-exploration-policy.js");
 const reader:any={list:async()=>[]};
 const provider=new AdaptiveExplorationPolicyProvider(reader,{enabled:true,minimumRate:0,maximumRate:.5});
 const candidates:any=[{product:{id:"p",marketplaceId:"m"}}];
 const rates=await provider.getRates(candidates,{explorationRate:.1}, {}, new Map([["m:p",{anomalyRecovery:"recovered",recoveryEpisodeMetrics:{qualityDelta:-.3}} as any]]));
 assert.equal(rates.get("p"),.35);
});
