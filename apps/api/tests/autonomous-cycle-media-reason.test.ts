import assert from "node:assert/strict";
import test from "node:test";
import { getMediaUnavailableReasonCode } from "../src/domain/autonomous-cycle.js";

test("reports rights-unverified media when no product has publishable media", () => {
  assert.equal(getMediaUnavailableReasonCode(0), "media_unavailable_rights_unverified");
});

test("does not report a media blocker when at least one product has publishable media", () => {
  assert.equal(getMediaUnavailableReasonCode(1), undefined);
  assert.equal(getMediaUnavailableReasonCode(25), undefined);
});

test("does not classify invalid counts as a media blocker", () => {
  assert.equal(getMediaUnavailableReasonCode(-1), undefined);
  assert.equal(getMediaUnavailableReasonCode(0.5), undefined);
  assert.equal(getMediaUnavailableReasonCode(Number.NaN), undefined);
});
