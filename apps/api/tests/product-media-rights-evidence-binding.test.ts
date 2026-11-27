import assert from "node:assert/strict";
import test from "node:test";
import type { ProductMediaAsset, ProductMediaRightsReviewCommand } from "../src/domain/product-media-ingestion.js";
import { validateProductMediaRightsEvidenceBinding } from "../src/domain/product-media-rights-evidence-binding.js";

const asset = (overrides: Partial<ProductMediaAsset> = {}): ProductMediaAsset => ({
  id: "11111111-1111-4111-8111-111111111111",
  productId: "22222222-2222-4222-8222-222222222222",
  kind: "image",
  bucket: "affiliate-media",
  objectKey: "products/item/image.jpg",
  mimeType: "image/jpeg",
  byteSize: 128,
  sha256: "a".repeat(64),
  sourceUrl: "https://publisher.example/item.jpg",
  sourcePublisher: "Publisher Example",
  sourceProvider: "wikimedia_commons",
  sourceLandingPageUrl: "https://commons.wikimedia.org/wiki/File:Item.jpg",
  sourceLicense: "CC BY 4.0",
  sourceLicenseVersion: "4.0",
  sourceLicenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  rightsStatus: "unverified",
  rightsBasis: null,
  rightsEvidenceUrl: null,
  rightsVerifiedAt: null,
  createdAt: new Date("2026-11-26T00:00:00Z").toISOString(),
  ...overrides
});

const review = (overrides: Partial<ProductMediaRightsReviewCommand> = {}): ProductMediaRightsReviewCommand => ({
  status: "verified",
  rightsBasis: "license",
  rightsEvidenceUrl: "https://commons.wikimedia.org/wiki/File:Item.jpg",
  sourcePublisher: "Publisher Example",
  actorId: "admin-1",
  actorRole: "admin",
  reason: "Inspected the exact asset page and its license statement.",
  ...overrides
});

test("accepts a license decision bound to the exact persisted asset page and publisher", () => {
  assert.doesNotThrow(() => validateProductMediaRightsEvidenceBinding(asset(), review()));
});

test("rejects a license claim when the asset has no persisted license metadata", () => {
  assert.throws(
    () => validateProductMediaRightsEvidenceBinding(asset({ sourceLicense: null, sourceLicenseUrl: null }), review()),
    /license metadata recorded/
  );
});

test("rejects an evidence URL that is unrelated to the asset provenance", () => {
  assert.throws(
    () => validateProductMediaRightsEvidenceBinding(asset(), review({ rightsEvidenceUrl: "https://other.example/license" })),
    /must match this asset's recorded source page/
  );
});

test("rejects a publisher that conflicts with the persisted asset provenance", () => {
  assert.throws(
    () => validateProductMediaRightsEvidenceBinding(asset(), review({ sourcePublisher: "Different Publisher" })),
    /does not match the asset's recorded provenance/
  );
});

test("rejects user-owned rights for catalog-discovered media", () => {
  assert.throws(
    () => validateProductMediaRightsEvidenceBinding(asset(), review({ rightsBasis: "user_owned" })),
    /only be attested for an asset recorded as a user upload/
  );
});

test("accepts user-owned rights only for a recorded user upload", () => {
  assert.doesNotThrow(() => validateProductMediaRightsEvidenceBinding(
    asset({ sourceProvider: "user_upload", sourceUrl: "user-upload://asset-1" }),
    review({ rightsBasis: "user_owned" })
  ));
});

test("rejects a vague rights verification reason", () => {
  assert.throws(
    () => validateProductMediaRightsEvidenceBinding(asset(), review({ reason: "Looks fine." })),
    /specific review reason/
  );
});

test("does not impose verification requirements when rights are revoked", () => {
  assert.doesNotThrow(() => validateProductMediaRightsEvidenceBinding(
    asset(),
    review({ status: "revoked", rightsBasis: undefined, rightsEvidenceUrl: undefined, sourcePublisher: undefined, reason: "Rights were withdrawn." })
  ));
});
