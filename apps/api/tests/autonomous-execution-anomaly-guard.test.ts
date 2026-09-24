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
 assert.match(result.outcomes[0].error, /anomaly/);
});


test("autonomous decision audit captures recovery context",async()=>{
 const audits:any[]=[];
 const decisionAudits:any={saveMany:async(xs:any[])=>audits.push(...xs),updateOutcome:async()=>{}};
 const performance=new Map([["m:p",{anomaly:"none",anomalyRecovery:"recovering",recoveryClicks:23,recoveryEvidenceScore:.62}]]);
 const feedback:any={getSignals:async()=>performance};
 const selector:any={select:()=>({selected:[],rejected:[],audit:[{auditId:"a",productId:"p",marketplaceId:"m",selected:false,score:1,policy:{},reasons:[],category:undefined,audienceSegments:undefined}]})};
 const service=new AutonomousExecutionService(selector,{} as any,feedback,undefined,decisionAudits);
 await service.runOnce({candidates:[],idempotencyNamespace:"cycle-recovery"});
 assert.equal(audits[0].recovery.recoveryState,"recovering");
 assert.equal(audits[0].recovery.recoveryClicks,23);
 assert.equal(audits[0].recovery.recoveryEvidenceScore,.62);
});
