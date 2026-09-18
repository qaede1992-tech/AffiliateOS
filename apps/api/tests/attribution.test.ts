import assert from "node:assert/strict";
import test from "node:test";
import { ConversionAttributionService, InMemoryConversionAttributionRepository } from "../src/domain/attribution.js";
import { InMemoryRepository, InMemoryTrackingLinkRepository } from "../src/domain/repository.js";

test("conversion attribution is explicit and one-to-one", async () => {
  const now = new Date().toISOString();
  const conversions = new InMemoryRepository<import("@affiliateos/shared").Conversion>();
  const links = new InMemoryTrackingLinkRepository();
  const attributions = new InMemoryConversionAttributionRepository();
  const conversionId = "00000000-0000-0000-0000-000000000301";
  const linkId = "00000000-0000-0000-0000-000000000302";
  await conversions.save({ id: conversionId, affiliateId: "00000000-0000-0000-0000-000000000303", offerId: "00000000-0000-0000-0000-000000000304", amountCents: 1000, status: "approved", occurredAt: now });
  await links.save({ id: linkId, affiliateOfferId: "00000000-0000-0000-0000-000000000305", code: "attr2", destinationUrl: "https://example.com", status: "active", createdAt: now, updatedAt: now });
  const service = new ConversionAttributionService(conversions, links, attributions);
  const created = await service.create(conversionId, { trackingLinkId: linkId });
  assert.equal(created.conversionId, conversionId);
  assert.equal((await service.create(conversionId, { trackingLinkId: linkId })).trackingLinkId, linkId);
  await assert.rejects(() => service.create(conversionId, { trackingLinkId: "00000000-0000-0000-0000-000000000306" }), /already attributed/i);
});

test("conversion attribution rejects missing and inactive targets", async () => {
  const conversions = new InMemoryRepository<import("@affiliateos/shared").Conversion>();
  const links = new InMemoryTrackingLinkRepository();
  const attributions = new InMemoryConversionAttributionRepository();
  const now = new Date().toISOString();
  const conversionId = "00000000-0000-0000-0000-000000000311";
  await assert.rejects(() => new ConversionAttributionService(conversions, links, attributions).create(conversionId, { trackingLinkId: "00000000-0000-0000-0000-000000000312" }), /conversion does not exist/i);
  await conversions.save({ id: conversionId, affiliateId: "00000000-0000-0000-0000-000000000313", offerId: "00000000-0000-0000-0000-000000000314", amountCents: 1000, status: "approved", occurredAt: now });
  await links.save({ id: "00000000-0000-0000-0000-000000000312", affiliateOfferId: "00000000-0000-0000-0000-000000000315", code: "attr3", destinationUrl: "https://example.com", status: "inactive", createdAt: now, updatedAt: now });
  await assert.rejects(() => new ConversionAttributionService(conversions, links, attributions).create(conversionId, { trackingLinkId: "00000000-0000-0000-0000-000000000312" }), /tracking link.*active/i);
});
