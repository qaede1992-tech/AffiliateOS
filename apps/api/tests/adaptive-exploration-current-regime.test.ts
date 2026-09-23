import assert from "node:assert/strict";
import test from "node:test";
import { AdaptiveExplorationPolicyProvider } from "../src/domain/adaptive-exploration-policy.js";

const candidate:any={product:{id:"p",marketplaceId:"m",category:"electronics",status:"active"},offers:[]};
const policy={minimumRate:0,maximumRate:0.5};

test("rising regime reduces exploration",async()=>{
 const p=new AdaptiveExplorationPolicyProvider({list:async()=>[]},policy);
 const rates=await p.getRates([candidate],{explorationRate:0.2},{},new Map([["m:p",{regime:"rising",regimeConfidence:0.8} as any]]));
 assert.equal(rates.get("p"),0.16);
});
test("declining regime increases exploration",async()=>{
 const p=new AdaptiveExplorationPolicyProvider({list:async()=>[]},policy);
 const rates=await p.getRates([candidate],{explorationRate:0.2},{},new Map([["m:p",{regime:"declining",regimeConfidence:0.8} as any]]));
 assert.equal(rates.get("p"),0.25);
});
test("low confidence does not alter exploration",async()=>{
 const p=new AdaptiveExplorationPolicyProvider({list:async()=>[]},policy);
 const rates=await p.getRates([candidate],{explorationRate:0.2},{},new Map([["m:p",{regime:"declining",regimeConfidence:0.3} as any]]));
 assert.equal(rates.get("p"),0.2);
});
