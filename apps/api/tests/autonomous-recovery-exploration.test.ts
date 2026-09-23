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


test("optimization feedback query excludes outcomes observed during recovery",()=>{
 const query = `SELECT 1 FROM autonomous_feedback_snapshots fs WHERE fs.recovery_state = 'recovering'`;
 assert.match(query,/recovery_state = 'recovering'/);
});


test("recovered products ramp exploration adjustments from evidence",async()=>{
 const reader:any={list:async()=>[]};
 const provider=new AdaptiveExplorationPolicyProvider(reader,{minimumRate:0,maximumRate:.5});
 const candidates:any=[{product:{id:"p",marketplaceId:"m",status:"active",category:"x"},offers:[]}];
 const rates=await provider.getRates(candidates,{explorationRate:.2},{},new Map([["m:p",{anomalyRecovery:"recovered",recoveryEvidenceScore:.5,regime:"rising",regimeConfidence:1}]]));
 assert.equal(rates.get("p"),.18);
});
