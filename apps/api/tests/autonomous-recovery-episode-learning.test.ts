import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("optimization learning isolates outcomes from older recovery episodes",()=>{
  const source=readFileSync(resolve(process.cwd(),"src/db/autonomous-exploration-state-repository.ts"),"utf8");
  assert.match(source,/current_recovery\.recovery_episode_id/);
  assert.match(source,/o\.recovery_episode_id <> current_recovery\.recovery_episode_id/);
  assert.match(source,/COALESCE\(o\.recovery_state, 'none'\) <> 'recovering'/);
});
