import assert from "node:assert/strict";
import test from "node:test";
import { AdaptiveExplorationPolicyProvider } from "../src/domain/adaptive-exploration-policy.js";

test("regime adjusts exploration rate before adaptive state", async()=>{
 const reader:any={list:async()=>[]};
 const provider=new AdaptiveExplorationPolicyProvider(reader,{minimumRate:0,maximumRate:0.5});
 const product:any={id:"p",marketplaceId:"m",category:"electronics",status:"active"};
 const rates=await provider.getRates([{product,offers:[]}],{explorationRate:0.2}, {}, new Map([["m:p",{regime:"declining"}]] as any));
 assert.equal(rates.get("p"),0.3);
});
test("rising regime reduces exploration", async()=>{
 const provider=new AdaptiveExplorationPolicyProvider({list:async()=>[]},{minimumRate:0,maximumRate:0.5});
 const product:any={id:"p",marketplaceId:"m",category:"electronics",status:"active"};
 const rates=await provider.getRates([{product,offers:[]}],{explorationRate:0.2}, {}, new Map([["m:p",{regime:"rising"}]] as any));
 assert.equal(rates.get("p"),0.15);
});
