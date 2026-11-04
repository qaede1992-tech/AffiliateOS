import assert from "node:assert/strict";
import test from "node:test";
import { findDuplicateSupabaseMigrationNames } from "../scripts/supabase-migration-ledger-audit.mjs";

test("reports repeated Supabase migration names with sorted versions", () => {
  const result = findDuplicateSupabaseMigrationNames([
    { name: "0067_reconcile", version: "20261029003122" },
    { name: "0066_product", version: "20261029003118" },
    { name: "0066_product", version: "20261029002934" },
    { name: "0067_reconcile", version: "20261029002943" },
    { name: "0068_media", version: "20261029004000" }
  ]);
  assert.deepEqual(result, [
    { name: "0066_product", versions: ["20261029002934", "20261029003118"] },
    { name: "0067_reconcile", versions: ["20261029002943", "20261029003122"] }
  ]);
});

test("ignores empty names and unique migration names", () => {
  assert.deepEqual(findDuplicateSupabaseMigrationNames([
    { name: "", version: "20261029000001" },
    { name: "  ", version: "20261029000002" },
    { name: "one_off_migration", version: "20261029000003" }
  ]), []);
});
