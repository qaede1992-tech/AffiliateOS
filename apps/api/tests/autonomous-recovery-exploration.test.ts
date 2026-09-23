import assert from "node:assert/strict";
import test from "node:test";
import { AdaptiveExplorationPolicyProvider } from "../src/domain/adaptive-exploration-policy.js";

test("recovering products receive conservative exploration floor",async()=>{
 const reader:any={list:async()=>[]};
 const provider=new AdaptiveExplorationPolicyProvider(reader,{minimumRate:0,maximumRate:.5});
 const candidates:any=[{product:{id:"p",marketplaceId:"m",status:"active",category:"x"},offers:[]}];
 const rates=await provider.getRates(candidates,{explorationRate:.1},{},new Map([["m:p",{anomalyRecovery:"recovering",regimeConfidence:1}]]));
 assert.equal(rates.get("p"),.35);
});
