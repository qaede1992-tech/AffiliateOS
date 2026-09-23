import assert from "node:assert/strict";
import test from "node:test";
import { applyPerformance } from "../src/domain/autonomous-opportunity.js";
test("recovered episode with negative economics receives reduced influence",()=>{
 const signal:any={adjustment:4,regime:"rising",regimeConfidence:1,anomalyRecovery:"recovered",recoveryEvidenceScore:1,recoveryEpisodeMetrics:{recoveryDurationMs:1000,recoveryClicks:50,conversionDelta:-1,commissionDeltaCents:-100}};
 const item:any={score:60,breakdown:{},product:{id:"p"}};
 const result=applyPerformance(item,signal);
 assert.ok(result.score < 64);
});
