import assert from "node:assert/strict";
import test from "node:test";
import { determineAutonomousHealthStatus } from "../src/domain/autonomous-health-status.js";

test("unsupported publishers do not degrade autonomous health", () => {
  assert.equal(determineAutonomousHealthStatus({
    schedulerRunning: true,
    publisherStatuses: ["ready", "ready", "unsupported", "unsupported"],
    recoverableRunCount: 0
  }), "healthy");
});

test("an unconfigured supported publisher degrades autonomous health", () => {
  assert.equal(determineAutonomousHealthStatus({
    schedulerRunning: true,
    publisherStatuses: ["ready", "unconfigured", "unsupported"],
    recoverableRunCount: 0
  }), "degraded");
});

test("recoverable autonomous runs degrade health", () => {
  assert.equal(determineAutonomousHealthStatus({
    schedulerRunning: true,
    publisherStatuses: ["ready", "unsupported"],
    recoverableRunCount: 1
  }), "degraded");
});

test("a scheduler error degrades health", () => {
  assert.equal(determineAutonomousHealthStatus({
    schedulerRunning: true,
    schedulerLastError: "cycle failed",
    publisherStatuses: ["ready", "unsupported"],
    recoverableRunCount: 0
  }), "degraded");
});

test("a stopped scheduler is disabled", () => {
  assert.equal(determineAutonomousHealthStatus({
    schedulerRunning: false,
    publisherStatuses: ["ready", "unsupported"],
    recoverableRunCount: 0
  }), "disabled");
});
