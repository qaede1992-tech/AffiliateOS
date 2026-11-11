export function classifyMigrationLedger({ trackedMigrations, appliedTimestamps }) {
  if (!Array.isArray(trackedMigrations) || trackedMigrations.length === 0) {
    throw new Error("Migration journal must contain at least one entry.");
  }
  if (!(appliedTimestamps instanceof Set) || appliedTimestamps.size === 0) {
    throw new Error("Production migration ledger is empty; refusing to run a production migration preflight.");
  }

  const latestAppliedTimestamp = Math.max(...appliedTimestamps);
  if (!Number.isSafeInteger(latestAppliedTimestamp)) {
    throw new Error("Production migration ledger has no valid latest timestamp.");
  }

  const missingMigrations = trackedMigrations.filter(
    (migration) => !appliedTimestamps.has(Number(migration.when))
  );
  const pendingMigrations = missingMigrations.filter(
    (migration) => Number(migration.when) > latestAppliedTimestamp
  );
  const historicalMissingMigrations = missingMigrations.filter(
    (migration) => Number(migration.when) <= latestAppliedTimestamp
  );

  return { pendingMigrations, historicalMissingMigrations, latestAppliedTimestamp };
}

export function findCompensatedHistoricalMigrationGaps({
  missingMigrations,
  appliedTimestamps,
  compensationTimestamp,
  forwardRepairTimestamp
}) {
  const legacyGapTags = [
    "0056_tiktok_publication_approval_and_media_duration",
    "0057_content_products_multi_product_story"
  ];
  const missing = new Set(missingMigrations);
  const compensated = new Set();

  const hasLegacyPair = legacyGapTags.every((tag) => missing.has(tag));
  if (
    hasLegacyPair &&
    compensationTimestamp !== null &&
    appliedTimestamps.has(compensationTimestamp)
  ) {
    for (const tag of legacyGapTags) compensated.add(tag);
  }

  const forwardRepairGapTag = "0067_reconcile_drifted_tiktok_and_content_products";
  if (
    missing.has(forwardRepairGapTag) &&
    forwardRepairTimestamp !== null &&
    appliedTimestamps.has(forwardRepairTimestamp)
  ) {
    compensated.add(forwardRepairGapTag);
  }

  return compensated;
}
