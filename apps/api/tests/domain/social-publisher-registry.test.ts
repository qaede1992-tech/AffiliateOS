import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SocialPublisherRegistry } from "../../src/domain/social-publisher-registry.js";
import type { SocialPublisher } from "../../src/domain/distribution-engine.js";

const publisher = (supports: (platform: string) => boolean): SocialPublisher => ({
  supports,
  publish: async () => ({ externalPostId: "external-post" })
});

describe("SocialPublisherRegistry", () => {
  it("selects a single publisher for a supported platform", () => {
    const target = publisher((platform) => platform === "tiktok");
    const registry = new SocialPublisherRegistry([target]);

    assert.equal(registry.get("tiktok"), target);
    assert.deepEqual(registry.list(), [target]);
  });

  it("rejects publishers that support no known platform", () => {
    assert.throws(
      () => new SocialPublisherRegistry([publisher(() => false)]),
      /must support at least one content platform/
    );
  });

  it("rejects duplicate platform ownership", () => {
    const first = publisher((platform) => platform === "tiktok");
    const second = publisher((platform) => platform === "tiktok");

    assert.throws(
      () => new SocialPublisherRegistry([first, second]),
      /already registered for tiktok/
    );
  });

  it("registers one publisher for multiple platforms without duplicating list entries", () => {
    const target = publisher((platform) => platform === "tiktok" || platform === "instagram");
    const registry = new SocialPublisherRegistry([target]);

    assert.equal(registry.get("tiktok"), target);
    assert.equal(registry.get("instagram"), target);
    assert.deepEqual(registry.list(), [target]);
  });
});
