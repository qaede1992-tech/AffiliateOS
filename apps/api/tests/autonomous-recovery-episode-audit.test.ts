import assert from "node:assert/strict";
import test from "node:test";
import { evaluateExploration } from "../src/domain/exploration-evaluator.js";

test("recovery exploration evaluation preserves episode lineage",()=>{
 const evaluation=evaluateExploration({
   auditId:"a",cycleId:"c",productId:"p",marketplaceId:"m",selected:true,
   selectionMode:"exploration",score:1,policy:{},reasons:[],createdAt:"2026-01-01T00:00:00Z",
   recovery:{anomaly:"none",recoveryState:"recovering",recoveryClicks:10,recoveryEvidenceScore:.4,recoveryEpisodeId:"episode-1"},
   outcome:{status:"completed",observedAt:"2026-01-02T00:00:00Z",analytics:{clickCount:50,attributedConversionCount:1,attributedRevenueCents:0,attributedCommissionCents:0,conversionRate:.02}}
 });
 assert.equal(evaluation?.recoveryEpisodeId,"episode-1");
 assert.equal(evaluation?.status,"continue-exploration");
});
