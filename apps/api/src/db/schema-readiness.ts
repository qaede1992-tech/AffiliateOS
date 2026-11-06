import { sql } from "drizzle-orm";

type ReadinessQueryResult = { rows?: unknown[] };
type ReadinessDatabase = {
  execute(query: ReturnType<typeof sql>): PromiseLike<ReadinessQueryResult>;
};

type MediaSchemaReadinessRow = {
  hasPreMediaEligibilityEvidence: boolean;
  hasPreMediaEligibilityColumns: boolean;
  hasProductMediaCandidateReviewAudits: boolean;
  hasProductMediaCandidateReviewAuditColumns: boolean;
  hasProductMediaProvenanceColumns: boolean;
  hasProductMediaCandidateReviewColumns: boolean;
};

/**
 * Verify the database contract used by the product-media discovery and review
 * pipeline. A successful SELECT 1 only proves connectivity; it does not prove
 * that the deployed schema can serve these runtime queries.
 */
export async function assertMediaSchemaReady(db: ReadinessDatabase): Promise<void> {
  const result = await db.execute(sql`
    SELECT
      to_regclass('public.pre_media_eligibility_evidence') IS NOT NULL
        AS "hasPreMediaEligibilityEvidence",
      (
        SELECT count(*) = 10
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'pre_media_eligibility_evidence'
          AND column_name IN (
            'id', 'cycle_id', 'product_id', 'marketplace_id', 'offer_id',
            'eligible', 'score', 'policy', 'reasons', 'created_at'
          )
      ) AS "hasPreMediaEligibilityColumns",
      to_regclass('public.product_media_candidate_review_audits') IS NOT NULL
        AS "hasProductMediaCandidateReviewAudits",
      (
        SELECT count(*) = 10
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'product_media_candidate_review_audits'
          AND column_name IN (
            'id', 'candidate_id', 'product_id', 'actor_id', 'actor_role',
            'action', 'reason', 'previous_status', 'new_status', 'created_at'
          )
      ) AS "hasProductMediaCandidateReviewAuditColumns",
      (
        SELECT count(*) = 10
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'product_media_assets'
          AND column_name IN (
            'source_provider',
            'source_candidate_id',
            'source_landing_page_url',
            'source_title',
            'source_query',
            'source_creator',
            'source_creator_url',
            'source_license',
            'source_license_version',
            'source_license_url'
          )
      ) AS "hasProductMediaProvenanceColumns",
      (
        SELECT count(*) = 3
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'product_media_candidates'
          AND column_name IN ('reviewed_by', 'reviewed_at', 'review_reason')
      ) AS "hasProductMediaCandidateReviewColumns"
  `);

  const row = result.rows?.[0] as MediaSchemaReadinessRow | undefined;
  if (
    row?.hasPreMediaEligibilityEvidence !== true ||
    row.hasPreMediaEligibilityColumns !== true ||
    row.hasProductMediaCandidateReviewAudits !== true ||
    row.hasProductMediaCandidateReviewAuditColumns !== true ||
    row.hasProductMediaProvenanceColumns !== true ||
    row.hasProductMediaCandidateReviewColumns !== true
  ) {
    throw new Error("Required product media schema is incomplete.");
  }
}
