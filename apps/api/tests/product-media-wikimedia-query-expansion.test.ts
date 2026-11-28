import assert from "node:assert/strict";
import test from "node:test";
import { buildWikimediaCommonsQueries } from "../src/domain/product-media-wikimedia-search.js";

test("uses a bounded set of category-specific Commons queries for crisper trays", () => {
  assert.deepEqual(
    buildWikimediaCommonsQueries({ name: "GSM Crisper Tray Cooper Carbon Steel Ceramic" }),
    ["crisper tray", "air fryer basket", "oven baking tray"]
  );
});

test("does not broaden Commons queries for generic product names", () => {
  assert.deepEqual(
    buildWikimediaCommonsQueries({ name: "GSM Premium Collection Cooper Edition" }),
    ["gsm premium collection cooper edition"]
  );
});
