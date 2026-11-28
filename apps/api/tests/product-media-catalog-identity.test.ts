import assert from "node:assert/strict";
import test from "node:test";
import { evaluateProductMediaIdentity } from "../src/domain/product-media-catalog-search.js";

const identity = { name: "GSM Crisper Tray Cooper Carbon Steel Ceramic" };

test("rejects category-only Commons titles that do not identify the Shopee product", () => {
  const categoryOnlyTitles = [
    "Oven Tray.jpg",
    "Sliced Zucchini, air fried with herbs - In basket.jpg",
    "Baking tray.jpg",
    "French fries cooked in an air fryer.jpg",
    "AirFryer Basket.jpg"
  ];

  for (const title of categoryOnlyTitles) {
    assert.equal(evaluateProductMediaIdentity(identity, title).status, "rejected", title);
  }
});

test("retains a product-specific title as review-required rather than auto-approved", () => {
  const result = evaluateProductMediaIdentity(identity, "GSM Cooper Crisper Tray Carbon Steel Ceramic");
  assert.equal(result.status, "review_required");
  assert.ok(result.score >= 65);
});
