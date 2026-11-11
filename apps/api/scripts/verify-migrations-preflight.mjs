import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Reuse the full read-only schema and migration verifier. The only difference
// from the post-migration verifier is that a contiguous, newer journal suffix
// may remain pending; all existing schema-contract and historical-drift checks
// still run before the migrator is allowed to mutate the database.
const verifierPath = fileURLToPath(new URL("./verify-migrations.mjs", import.meta.url));
const result = spawnSync(
  process.execPath,
  [verifierPath, "--allow-pending-suffix"],
  { env: process.env, stdio: "inherit" }
);

if (result.error) throw result.error;
if (result.signal) throw new Error(`Migration preflight verifier terminated by signal ${result.signal}.`);
process.exitCode = result.status ?? 1;
