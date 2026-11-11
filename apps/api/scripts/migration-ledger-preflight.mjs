export function classifyMigrationLedger({ trackedMigrations, appliedTimestamps }) {
  if (!Array.isArray(trackedMigrations) || trackedMigrations.length === 0) {
    throw new Error("Migration journal must contain at least one entry.");
  }
  if (!(appliedTimestamps instanceof Set) || appliedTimestamps.size === 0) {
    throw new Error("Production migration ledger is empty; refusing to run a production migration preflight.");
  }

  // Drizzle applies entries in journal order. Do not infer the applied prefix
  // from numeric timestamps: historical entries have been inserted with
  // non-monotonic `when` values, so a missing middle entry can have a timestamp
  // greater than a later applied entry.
  const journalIndexByTimestamp = new Map();
  for (const [index, migration] of trackedMigrations.entries()) {
    const timestamp = Number(migration.when);
    if (!Number.isSafeInteger(timestamp)) {
      throw new Error(`Migration ${migration.tag} has an invalid timestamp: ${migration.when}.`);
    }
    if (journalIndexByTimestamp.has(timestamp)) {
      throw new Error(`Journal timestamp ${timestamp} is duplicated.`);
    }
    journalIndexByTimestamp.set(timestamp, index);
  }

  const appliedIndexes = [];
  for (const timestamp of appliedTimestamps) {
    const index = journalIndexByTimestamp.get(Number(timestamp));
    if (index === undefined) {
      throw new Error(`Production migration ledger contains timestamp ${timestamp}, which is absent from the checked-out journal.`);
    }
    appliedIndexes.push(index);
  }

  const latestAppliedIndex = Math.max(...appliedIndexes);
  const latestAppliedTimestamp = Number(trackedMigrations[latestAppliedIndex].when);
  const missingMigrations = trackedMigrations.filter(
    (migration) => !appliedTimestamps.has(Number(migration.when))
  );
  const pendingMigrations = missingMigrations.filter(
    (migration) => journalIndexByTimestamp.get(Number(migration.when)) > latestAppliedIndex
  );
  const historicalMissingMigrations = missingMigrations.filter(
    (migration) => journalIndexByTimestamp.get(Number(migration.when)) <= latestAppliedIndex
  );

  return {
    pendingMigrations,
    historicalMissingMigrations,
    latestAppliedIndex,
    latestAppliedTimestamp
  };
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
