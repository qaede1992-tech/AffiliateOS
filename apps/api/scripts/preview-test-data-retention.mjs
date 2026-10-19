import pg from "pg";

const { Pool } = pg;

function positiveInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`Expected an integer from 1 to ${maximum}, received: ${value}`);
  }
  return parsed;
}

const retentionDays = positiveInteger(process.env.TEST_DATA_RETENTION_DAYS, 30, 3650);
const limit = positiveInteger(process.env.TEST_DATA_RETENTION_LIMIT, 100, 500);
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required. This command only previews candidates; it never deletes data.");
  process.exitCode = 1;
} else {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    application_name: "affiliateos-test-data-retention-preview",
    options: "-c default_transaction_read_only=on"
  });

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

      const campaigns = await client.query(
        `SELECT c.id, c.name, c.status, c.updated_at,
          EXISTS (SELECT 1 FROM content x WHERE x.campaign_id = c.id) AS has_content,
          EXISTS (SELECT 1 FROM tracking_links t WHERE t.campaign_id = c.id) AS has_tracking_links,
          EXISTS (SELECT 1 FROM campaign_offers co WHERE co.campaign_id = c.id) AS has_offer_links
        FROM campaigns c
        WHERE c.is_test = true
          AND c.updated_at < $1
          AND c.status IN ('completed', 'archived')
        ORDER BY c.updated_at ASC
        LIMIT $2`,
        [cutoff, limit]
      );

      const runs = await client.query(
        `SELECT r.id, r.status, r.updated_at, r.campaign_id
        FROM autonomous_runs r
        WHERE r.is_test = true
          AND r.updated_at < $1
          AND r.status IN ('completed', 'failed')
        ORDER BY r.updated_at ASC
        LIMIT $2`,
        [cutoff, limit]
      );

      const campaignRows = campaigns.rows.map((row) => {
        const blockers = [];
        if (row.has_content) blockers.push("campaign has content; publication history must be reviewed");
        if (row.has_tracking_links) blockers.push("campaign has tracking links; click/attribution history must be preserved");
        if (row.has_offer_links) blockers.push("campaign has linked offers; relationship cleanup is not implemented");
        return { id: row.id, name: row.name, status: row.status, updatedAt: row.updated_at, decision: blockers.length ? "blocked" : "candidate_for_manual_review", blockers };
      });

      const runRows = runs.rows.map((row) => {
        const blockers = [];
        if (row.campaign_id) blockers.push("run references a campaign; linked lifecycle requires review");
        return { id: row.id, status: row.status, updatedAt: row.updated_at, campaignId: row.campaign_id, decision: blockers.length ? "blocked" : "candidate_for_manual_review", blockers };
      });

      await client.query("ROLLBACK");
      console.log(JSON.stringify({
        mode: "dry-run",
        readOnly: true,
        deletionPerformed: false,
        retentionDays,
        cutoff,
        perEntityLimit: limit,
        note: "Candidates are not deletion approval. Review dependencies and retention policy before any future cleanup implementation.",
        campaigns: { scanned: campaignRows.length, candidatesForManualReview: campaignRows.filter((x) => x.decision === "candidate_for_manual_review").length, blocked: campaignRows.filter((x) => x.decision === "blocked").length, rows: campaignRows },
        autonomousRuns: { scanned: runRows.length, candidatesForManualReview: runRows.filter((x) => x.decision === "candidate_for_manual_review").length, blocked: runRows.filter((x) => x.decision === "blocked").length, rows: runRows }
      }, null, 2));
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Test-data retention preview failed; no data was deleted.");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
