import assert from "node:assert/strict";
import test from "node:test";
import { inheritProductMediaSourceProvenance } from "../src/domain/product-promo-video-renderer.js";
import type { ProductMediaAsset } from "../src/domain/product-media-ingestion.js";

const source = {
  id: "source-image",
  productId: "product-1",
  kind: "image",
  bucket: "affiliate-media",
  objectKey: "products/product-1/source.webp",
  mimeType: "image/webp",
  byteSize: 1024,
  sha256: "a".repeat(64),
  sourceUrl: "https://images.example/source.webp",
  sourcePublisher: "Manufacturer",
  sourceProvider: "openverse",
  sourceCandidateId: "candidate-1",
  sourceLandingPageUrl: "https://manufacturer.example/product",
  sourceTitle: "Official product image",
  sourceQuery: "brand model",
  sourceCreator: "Creator",
  sourceCreatorUrl: "https://creator.example",
  sourceLicense: "CC BY 4.0",
  sourceLicenseVersion: "4.0",
  sourceLicenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  rightsStatus: "verified",
  rightsBasis: "license",
  rightsEvidenceUrl: "https://manufacturer.example/terms",
  rightsVerifiedAt: "2026-11-20T00:00:00.000Z",
  createdAt: "2026-11-20T00:00:00.000Z"
} as ProductMediaAsset;

test("rendered promo derivatives retain source provenance without inheriting candidate identity or rights approval", () => {
  const provenance = inheritProductMediaSourceProvenance(source);
  assert.deepEqual(provenance, {
    sourcePublisher: "Manufacturer",
    sourceProvider: "openverse",
    sourceLandingPageUrl: "https://manufacturer.example/product",
    sourceTitle: "Official product image",
    sourceQuery: "brand model",
    sourceCreator: "Creator",
    sourceCreatorUrl: "https://creator.example",
    sourceLicense: "CC BY 4.0",
    sourceLicenseVersion: "4.0",
    sourceLicenseUrl: "https://creativecommons.org/licenses/by/4.0/"
  });
  assert.equal("sourceCandidateId" in provenance, false);
  assert.equal("rightsStatus" in provenance, false);
  assert.equal("rightsEvidenceUrl" in provenance, false);
});
