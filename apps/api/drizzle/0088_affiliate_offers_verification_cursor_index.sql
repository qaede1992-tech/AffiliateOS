CREATE INDEX IF NOT EXISTS affiliate_offers_verification_cursor_idx
  ON public.affiliate_offers (created_at ASC, id ASC);
