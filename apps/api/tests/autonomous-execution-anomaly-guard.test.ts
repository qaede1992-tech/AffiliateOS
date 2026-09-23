import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousExecutionService } from "../src/domain/autonomous-execution.js";

test("halt anomaly blocks campaign orchestration",async()=>{
 const candidate:any={product:{id:"p",marketplaceId:"m",status:"active",name:"P"},offers:[{id:"o",status:"active"}]};
 const selector:any={select:()=>({selected:[{product:candidate.product,offerId:"o",score:80}],rejected:[],audit:[{auditId:"a",productId:"p",marketplaceId:"m",selected:true,score:80,policy:{},reasons:[]}]})};
 let executed=0;
 const orchestrator:any={execute:async()=>{executed++;throw new Error("should not execute");}};
 const feedback:any={getSignals:async()=>new Map([["m:p",{adjustment:0,anomaly:"halt"}]])};
 const audits:any={saveMany:async()=>{},updateOutcome:async()=>{}};
 const service=new AutonomousExecutionService(selector,orchestrator,feedback,undefined,audits);
 const result=await service.runOnce({candidates:[candidate],idempotencyNamespace:"test"});
 assert.equal(executed,0);
 assert.equal(result.outcomes[0].status,"failed");
 assert.match(result.outcomes[0].error,"anomaly");
});
