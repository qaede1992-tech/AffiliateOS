ALTER TABLE media_assets
  ADD COLUMN width_px integer,
  ADD COLUMN height_px integer,
  ADD COLUMN has_audio boolean;

ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_dimensions_positive_check
  CHECK (
    (width_px IS NULL AND height_px IS NULL)
    OR (width_px IS NOT NULL AND height_px IS NOT NULL AND width_px > 0 AND height_px > 0)
  );
