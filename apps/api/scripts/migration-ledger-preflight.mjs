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


export function getPendingMigrationSchemaExemptions(pendingMigrationTags) {
  const tables = new Set();
  const columns = new Set();
  const indexes = new Set();
  const exemptions = {
    // Migration 0060 is intentionally pending in the production-like CI
    // preflight simulation. Only its own schema objects may be absent before
    // the migrator runs; every other existing schema contract remains checked.
    "0060_test_data_retention_markers": {
      columns: ["campaigns.is_test", "autonomous_runs.is_test"],
      indexes: ["campaigns_test_created_idx", "autonomous_runs_test_created_idx"]
    },
    "0088_affiliate_offers_verification_cursor_index": {
      columns: [],
      indexes: ["affiliate_offers_verification_cursor_idx"]
    },
    // 0093 is a pending additive migration in the audited 0059 production-like
    // state. Its tables, columns, and indexes must not be required until applied.
    "0093_illustrative_creative_provenance": {
      tables: [
        "illustrative_creative_policies",
        "generated_product_creatives",
        "generated_product_creative_review_audits",
        "illustrative_creative_policy_audits"
      ],
      columns: [
        "illustrative_creative_policies.platform",
        "illustrative_creative_policies.enabled",
        "illustrative_creative_policies.policy_version",
        "generated_product_creatives.id",
        "generated_product_creatives.media_asset_id",
        "generated_product_creatives.content_id",
        "generated_product_creatives.product_id",
        "generated_product_creatives.affiliate_offer_id",
        "generated_product_creatives.sha256",
        "generated_product_creatives.disclosure_embedded",
        "generated_product_creatives.review_status",
        "generated_product_creative_review_audits.creative_id",
        "illustrative_creative_policy_audits.platform"
      ],
      indexes: [
        "generated_product_creatives_media_asset_unique",
        "generated_product_creatives_product_status_idx",
        "generated_product_creatives_content_idx",
        "generated_product_creative_review_audits_creative_created_idx",
        "illustrative_creative_policy_audits_platform_created_idx"
      ]
    }
  };

  for (const tag of pendingMigrationTags ?? []) {
    const exemption = exemptions[tag];
    if (!exemption) continue;
    for (const table of exemption.tables ?? []) tables.add(table);
    for (const column of exemption.columns) columns.add(column);
    for (const index of exemption.indexes) indexes.add(index);
  }

  return { tables, columns, indexes };
}
