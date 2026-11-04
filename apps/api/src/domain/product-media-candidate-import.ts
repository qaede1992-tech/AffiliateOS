import type { AffiliateOffer, Product } from "@affiliateos/shared";
import type { AutonomousDecisionAuditReader } from "./autonomous-decision-audit.js";
import type { ProductMediaCandidateRecord, ProductMediaCandidateRepository } from "./product-media-candidate.js";
import type { ProductMediaAsset, ProductMediaAssetRepository, ProductMediaIngestionService } from "./product-media-ingestion.js";

export class ProductMediaCandidateImportError extends Error {
  constructor(
    readonly code: "CANDIDATE_NOT_FOUND" | "CANDIDATE_NOT_APPROVED" | "PRODUCT_NOT_ELIGIBLE" | "PRODUCT_NOT_RECENTLY_SELECTED" | "AFFILIATE_OFFER_UNAVAILABLE" | "MEDIA_IMPORT_FAILED",
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "ProductMediaCandidateImportError";
  }
}

export interface ProductMediaCandidateImportResult {
  asset: ProductMediaAsset;
  alreadyImported: boolean;
}

export interface ProductMediaCandidateImportDependencies {
  candidates: ProductMediaCandidateRepository;
  assets: ProductMediaAssetRepository;
  ingestion: ProductMediaIngestionService;
  audits: AutonomousDecisionAuditReader;
  listProducts(): Promise<Product[]>;
  listAffiliateOffers(): Promise<AffiliateOffer[]>;
  now?: () => Date;
  selectionMaxAgeMs?: number;
}

const isUsableAffiliateOffer = (offer: AffiliateOffer, productId: string, now: Date): boolean => {
  const metadata = offer.availabilityMetadata ?? {};
  const explicitlyIneligible = ["affiliateEligible", "commissionEligible", "isEligible"].some((key) => metadata[key] === false);
  if (explicitlyIneligible || offer.productId !== productId || offer.status !== "active" || offer.affiliateLinkStatus !== "active" || !offer.affiliateUrl) return false;
  try {
    const url = new URL(offer.affiliateUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  } catch {
    return false;
  }
  if (!offer.affiliateLinkExpiresAt) return true;
  const expiry = Date.parse(offer.affiliateLinkExpiresAt);
  return Number.isFinite(expiry) && expiry > now.getTime();
};

/**
 * Imports only admin-approved image candidates for products with a recent
 * successful autonomous selection and a currently executable affiliate offer.
 * Importing never verifies rights or makes the resulting asset publishable.
 */
export class ProductMediaCandidateImportService {
  private readonly now: () => Date;
  private readonly selectionMaxAgeMs: number;

  constructor(private readonly dependencies: ProductMediaCandidateImportDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.selectionMaxAgeMs = dependencies.selectionMaxAgeMs ?? 24 * 60 * 60 * 1000;
  }

  async importApprovedCandidate(productId: string, candidateId: string): Promise<ProductMediaCandidateImportResult> {
    const { candidates, assets, ingestion, audits } = this.dependencies;
    if (!candidates.findById) {
      throw new ProductMediaCandidateImportError("MEDIA_IMPORT_FAILED", "Candidate lookup is not configured.", 503);
    }
    const candidate = await candidates.findById(candidateId);
    if (!candidate || candidate.productId !== productId) {
      throw new ProductMediaCandidateImportError("CANDIDATE_NOT_FOUND", "The media candidate was not found for this product.", 404);
    }
    if (candidate.reviewStatus !== "approved") {
      throw new ProductMediaCandidateImportError("CANDIDATE_NOT_APPROVED", "Only an administrator-approved media candidate can be imported.", 409);
    }
    if (candidate.rightsStatus === "revoked") {
      throw new ProductMediaCandidateImportError("CANDIDATE_NOT_APPROVED", "A candidate with revoked rights cannot be imported.", 409);
    }

    const existing = await assets.findBySourceCandidateId?.(candidate.id);
    if (existing) return { asset: existing, alreadyImported: true };

    const now = this.now();
    const products = await this.dependencies.listProducts();
    const product = products.find((item) => item.id === productId);
    if (!product || product.status !== "active") {
      throw new ProductMediaCandidateImportError("PRODUCT_NOT_ELIGIBLE", "The product is no longer active.", 409);
    }

    const latestDecision = (await audits.list({ productId, limit: 1 }))[0];
    const decisionAge = latestDecision ? now.getTime() - Date.parse(latestDecision.createdAt) : Number.POSITIVE_INFINITY;
    if (!latestDecision || !latestDecision.selected || !Number.isFinite(decisionAge) || decisionAge < 0 || decisionAge > this.selectionMaxAgeMs) {
      throw new ProductMediaCandidateImportError("PRODUCT_NOT_RECENTLY_SELECTED", "The product does not have a recent successful autonomous selection.", 409);
    }

    const offers = await this.dependencies.listAffiliateOffers();
    if (!offers.some((offer) => isUsableAffiliateOffer(offer, productId, now))) {
      throw new ProductMediaCandidateImportError("AFFILIATE_OFFER_UNAVAILABLE", "The product no longer has an active, usable affiliate offer and link.", 409);
    }

    const result = await ingestion.ingest({
      productId,
      nonMediaEligibilityPassed: true,
      candidates: [{
        kind: "image",
        url: candidate.imageUrl,
        source: "catalog",
        provenance: {
          provider: candidate.provider,
          candidateId: candidate.id,
          landingPageUrl: candidate.landingPageUrl,
          title: candidate.title,
          query: candidate.query,
          creator: candidate.creator,
          creatorUrl: candidate.creatorUrl,
          license: candidate.license,
          licenseVersion: candidate.licenseVersion,
          licenseUrl: candidate.licenseUrl,
          sourcePublisher: candidate.sourcePublisher
        }
      }]
    });
    const imported = result.stored.find((asset) => asset.sourceCandidateId === candidate.id);
    if (!imported) {
      throw new ProductMediaCandidateImportError(
        "MEDIA_IMPORT_FAILED",
        result.skipped[0]?.reason ?? "The candidate did not produce a new provenance-linked media asset.",
        422
      );
    }
    return { asset: imported, alreadyImported: false };
  }
}
