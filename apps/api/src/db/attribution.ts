import type { ConversionAttribution } from "@affiliateos/shared";
import { sql } from "drizzle-orm";
import type { ConversionAttributionRepository } from "../domain/attribution.js";

export class DrizzleConversionAttributionRepository implements ConversionAttributionRepository {
  constructor(private readonly db: any) {}

  async list(): Promise<ConversionAttribution[]> {
    const result = await this.db.execute(sql`SELECT conversion_id, tracking_link_id, attributed_at FROM conversion_attributions ORDER BY attributed_at ASC`);
    return rowsOf(result).map(toDomain);
  }

  async findById(id: string): Promise<ConversionAttribution | undefined> {
    const result = await this.db.execute(sql`SELECT conversion_id, tracking_link_id, attributed_at FROM conversion_attributions WHERE conversion_id = ${id} LIMIT 1`);
    return rowsOf(result)[0] ? toDomain(rowsOf(result)[0]) : undefined;
  }

  async findByConversion(conversionId: string): Promise<ConversionAttribution | undefined> {
    return this.findById(conversionId);
  }

  async save(entity: ConversionAttribution): Promise<ConversionAttribution> {
    await this.db.execute(sql`
      INSERT INTO conversion_attributions (conversion_id, tracking_link_id, attributed_at)
      VALUES (${entity.conversionId}, ${entity.trackingLinkId}, ${entity.attributedAt})
    `);
    return entity;
  }
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
}

function toDomain(row: Record<string, unknown>): ConversionAttribution {
  return { conversionId: String(row.conversion_id), trackingLinkId: String(row.tracking_link_id), attributedAt: String(row.attributed_at) };
}
