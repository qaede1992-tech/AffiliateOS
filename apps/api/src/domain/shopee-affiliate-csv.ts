export type ShopeeSalesValue = {
  value: number | null;
  quality: "exact" | "lower_bound" | "missing";
  sourceText: string;
};

export type ParsedShopeeAffiliateCsvRow = {
  externalProductId: string;
  name: string;
  shopName: string;
  category?: string;
  priceRupiah: number;
  soldCount: ShopeeSalesValue;
  reviewCount: ShopeeSalesValue;
  ratingMilli?: number;
  commissionRateBps: number | null;
  commissionAmountRupiah: number | null;
  productUrl: string;
  affiliateUrl: string;
  imageUrl?: string;
  videoUrl?: string;
};

export type ShopeeAffiliateCsvParseResult = {
  rows: ParsedShopeeAffiliateCsvRow[];
  errors: Array<{ row: number; message: string }>;
};

const REQUIRED_HEADERS = ["ID Produk", "Nama Produk", "Harga", "Penjualan", "Nama Toko", "Komisi hingga", "Komisi", "Link Produk", "Link Komisi Ekstra"] as const;

function parseCsvRecords(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let afterClosingQuote = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else { quoted = false; afterClosingQuote = true; }
      } else field += char;
      continue;
    }
    if (afterClosingQuote) {
      if (char === ",") { record.push(field); field = ""; afterClosingQuote = false; }
      else if (char === "\n" || char === "\r") {
        if (char === "\r" && text[i + 1] === "\n") i += 1;
        record.push(field);
        if (record.some((value) => value.trim() !== "")) records.push(record);
        record = []; field = ""; afterClosingQuote = false;
      } else {
        throw new Error("CSV tidak valid: terdapat karakter setelah tanda kutip penutup.");
      }
      continue;
    }
    if (char === '"') {
      if (field.length !== 0) throw new Error("CSV tidak valid: tanda kutip berada di tengah nilai tanpa escape.");
      quoted = true;
    } else if (char === ",") { record.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      record.push(field);
      if (record.some((value) => value.trim() !== "")) records.push(record);
      record = []; field = "";
    } else field += char;
  }
  if (quoted) throw new Error("CSV tidak valid: tanda kutip tidak ditutup.");
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    if (record.some((value) => value.trim() !== "")) records.push(record);
  }
  return records;
}

function parseRupiah(value: string): number | null {
  const normalized = value.trim().toUpperCase().replace(/^RP\s*/, "").replace(/\s/g, "");
  if (!normalized) return null;
  const abbreviated = normalized.match(/^(\d+(?:[.,]\d+)?)RB$/);
  const abbreviatedAmount = abbreviated?.[1];
  if (abbreviatedAmount !== undefined) {
    const amount = Number(abbreviatedAmount.replace(",", "."));
    if (!Number.isFinite(amount)) return null;
    const roundedAmount = Math.round(amount * 1000);
    return Number.isSafeInteger(roundedAmount) && Number.isSafeInteger(roundedAmount * 100) ? roundedAmount : null;
  }
  // Indonesian thousands separators must form three-digit groups; otherwise
  // malformed values such as "1.2.3" could silently become 123.
  if (!/^\d+(?:\.\d{3})*$/.test(normalized)) return null;
  const amount = Number(normalized.replace(/\./g, ""));
  // Downstream stores Rupiah as integer cents (Rupiah * 100). Keep the scaled
  // value within JavaScript's safe integer range before it reaches Drizzle.
  return Number.isSafeInteger(amount) && Number.isSafeInteger(amount * 100) ? amount : null;
}

function parseRateBps(value: string): number | null {
  const normalized = value.trim().replace(/%$/, "").replace(",", ".");
  // Accept ordinary decimal percentages only; Number() alone also accepts
  // exponent notation (for example, "1e2"), which is not a valid CSV rate.
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const rate = Number(normalized);
  return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? Math.round(rate * 100) : null;
}

function parseSales(value: string): ShopeeSalesValue {
  const sourceText = value.trim();
  const normalized = sourceText.toUpperCase().replace(/\s/g, "");
  if (!normalized) return { value: null, quality: "missing", sourceText };
  const approximate = normalized.match(/^(\d+(?:[.,]\d+)?)RB\+?$/);
  const approximateSales = approximate?.[1];
  if (approximateSales !== undefined) {
    const count = Number(approximateSales.replace(",", ".")) * 1000;
    const roundedCount = Math.round(count);
    return Number.isSafeInteger(roundedCount)
      ? { value: roundedCount, quality: "lower_bound", sourceText }
      : { value: null, quality: "missing", sourceText };
  }
  // Exact sales counts must use valid Indonesian thousands grouping.
  if (!/^\d+(?:\.\d{3})*$/.test(normalized)) return { value: null, quality: "missing", sourceText };
  const count = Number(normalized.replace(/\./g, ""));
  return Number.isSafeInteger(count)
    ? { value: count, quality: "exact", sourceText }
    : { value: null, quality: "missing", sourceText };
}

function parseRatingMilli(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) return null;
  if (!/^(?:[0-4](?:\.\d{1,3})?|5(?:\.0{1,3})?)$/.test(normalized)) return null;
  const rating = Number(normalized);
  if (!Number.isFinite(rating) || rating < 0 || rating > 5) return null;
  return Math.round(rating * 1000);
}

function isShopeeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" && (host === "shopee.co.id" || host === "s.shopee.co.id" || host === "shopee.ee" || host === "shope.ee" || host.endsWith(".shopee.co.id"));
  } catch { return false; }
}

function isHttpsMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0 && url.username === "" && url.password === "";
  } catch { return false; }
}

/** Parses supported Shopee affiliate CSV shapes; performs no persistence or URL fetching. */
export function parseShopeeAffiliateCsv(input: string): ShopeeAffiliateCsvParseResult {
  const initialRecords = parseCsvRecords(input);
  const initialHeaders = initialRecords[0]?.map((header) => header.trim()) ?? [];
  const previewHeaders = ["external_product_id", "name", "price_idr", "sold_count_value", "sold_count_quality", "shop_name", "commission_rate_bps", "commission_amount_idr", "product_url", "affiliate_url"] as const;
  const isPreviewFormat = initialHeaders.some((header) => previewHeaders.includes(header as (typeof previewHeaders)[number]));
  if (isPreviewFormat) {
    const duplicateHeaders = initialHeaders.filter((header, index) => initialHeaders.indexOf(header) !== index);
    if (duplicateHeaders.length > 0) return { rows: [], errors: [{ row: 1, message: `Header CSV duplikat: ${[...new Set(duplicateHeaders)].join(", ")}.` }] };
    const missing = previewHeaders.filter((header) => !initialHeaders.includes(header));
    if (missing.length > 0) return { rows: [], errors: [{ row: 1, message: `Kolom format preview tidak ditemukan: ${missing.join(", ")}.` }] };
    const indexes = new Map(initialHeaders.map((header, index) => [header, index]));
    if (indexes.has("review_count_value") !== indexes.has("review_count_quality")) {
      return { rows: [], errors: [{ row: 1, message: "review_count_value dan review_count_quality harus disediakan bersama." }] };
    }
    const previewErrors: ShopeeAffiliateCsvParseResult["errors"] = [];
    const previewRows: ParsedShopeeAffiliateCsvRow[] = [];
    const seenPreviewIds = new Set<string>();
    initialRecords.slice(1).forEach((record, index) => {
      const rowNumber = index + 2;
      if (record.length !== initialHeaders.length) {
        previewErrors.push({ row: rowNumber, message: `Jumlah kolom tidak sesuai: diharapkan ${initialHeaders.length}, ditemukan ${record.length}.` });
        return;
      }
      const get = (header: (typeof previewHeaders)[number]) => (record[indexes.get(header) ?? -1] ?? "").trim();
      const id = get("external_product_id");
      const name = get("name");
      const price = get("price_idr");
      const sales = get("sold_count_value");
      const salesQuality = get("sold_count_quality");
      const shop = get("shop_name");
      const rate = get("commission_rate_bps");
      const commission = get("commission_amount_idr");
      const productUrl = get("product_url");
      const affiliateUrl = get("affiliate_url");
      const imageUrl = (record[indexes.get("image_url") ?? -1] ?? "").trim();
      const videoUrl = (record[indexes.get("video_url") ?? indexes.get("videoUrl") ?? -1] ?? "").trim();
      const categoryHeaders = ["category", "category_name", "kategori", "kategori_produk"].filter((header) => indexes.has(header));
      const category = categoryHeaders.length === 1 ? (record[indexes.get(categoryHeaders[0]!) ?? -1] ?? "").trim() : "";
      const ratingText = (record[indexes.get("rating_milli") ?? -1] ?? "").trim();
      const reviewValueText = (record[indexes.get("review_count_value") ?? -1] ?? "").trim();
      const reviewQualityText = (record[indexes.get("review_count_quality") ?? -1] ?? "").trim();
      const ratingMilli = ratingText ? Number(ratingText) : undefined;
      const reviewCountValue = reviewValueText ? Number(reviewValueText) : null;
      const reviewCount = reviewQualityText === "missing" || !reviewQualityText
        ? { value: null, quality: "missing" as const, sourceText: "" }
        : {
            value: reviewCountValue,
            quality: reviewQualityText as ShopeeSalesValue["quality"],
            sourceText: reviewQualityText === "lower_bound" ? `${reviewValueText}+` : reviewValueText,
          };
      const rowProblems: string[] = [];
      const priceValue = Number(price);
      const salesValue = Number(sales);
      const rateValue = Number(rate);
      const commissionValue = Number(commission);
      if (!id) rowProblems.push("external_product_id kosong");
      if (!name) rowProblems.push("name kosong");
      if (!/^\d+$/.test(price) || !Number.isSafeInteger(priceValue) || !Number.isSafeInteger(priceValue * 100)) rowProblems.push("price_idr tidak valid");
      if (salesQuality !== "exact" && salesQuality !== "lower_bound" && salesQuality !== "missing") rowProblems.push("sold_count_quality harus exact, lower_bound, atau missing");
      if (salesQuality !== "missing" && (!/^\d+$/.test(sales) || !Number.isSafeInteger(salesValue))) rowProblems.push("sold_count_value tidak valid");
      if (salesQuality === "missing" && sales !== "" && sales !== "0") rowProblems.push("sold_count_value harus kosong atau 0 jika quality missing");
      if (!/^\d+$/.test(rate) || !Number.isSafeInteger(rateValue) || rateValue > 10000) rowProblems.push("commission_rate_bps harus bilangan bulat antara 0 dan 10000");
      if (!/^\d+$/.test(commission) || !Number.isSafeInteger(commissionValue) || !Number.isSafeInteger(commissionValue * 100)) rowProblems.push("commission_amount_idr tidak valid");
      if (ratingText && (!/^\d+$/.test(ratingText) || !Number.isInteger(ratingMilli) || ratingMilli! < 0 || ratingMilli! > 5000)) rowProblems.push("rating_milli harus bilangan bulat antara 0 dan 5000");
      if (categoryHeaders.length > 1) rowProblems.push("Gunakan hanya satu kolom kategori agar sumber data tidak ambigu");
      if (category.length > 120) rowProblems.push("category maksimal 120 karakter");
      if (indexes.has("review_count_quality") && !["exact", "lower_bound", "missing"].includes(reviewQualityText)) rowProblems.push("review_count_quality harus exact, lower_bound, atau missing");
      if (reviewQualityText === "missing" && reviewValueText && reviewValueText !== "0") rowProblems.push("review_count_value harus kosong atau 0 jika quality missing");
      if (reviewQualityText && reviewQualityText !== "missing" && (!/^\d+$/.test(reviewValueText) || !Number.isSafeInteger(Number(reviewValueText)))) rowProblems.push("review_count_value tidak valid");
      if (Number.isSafeInteger(priceValue) && Number.isSafeInteger(commissionValue) && commissionValue > priceValue) rowProblems.push("Komisi tidak boleh melebihi harga produk");
      if (!isShopeeUrl(productUrl)) rowProblems.push("product_url bukan URL HTTPS Shopee yang valid");
      if (!isShopeeUrl(affiliateUrl)) rowProblems.push("affiliate_url bukan URL HTTPS Shopee yang valid");
      if (imageUrl && !isHttpsMediaUrl(imageUrl)) rowProblems.push("image_url harus berupa URL HTTPS yang valid tanpa kredensial");
      if (videoUrl && !isHttpsMediaUrl(videoUrl)) rowProblems.push("video_url harus berupa URL HTTPS yang valid tanpa kredensial");
      if (id && seenPreviewIds.has(id)) rowProblems.push("external_product_id duplikat dalam file");
      if (id) seenPreviewIds.add(id);
      if (rowProblems.length > 0) { previewErrors.push({ row: rowNumber, message: rowProblems.join("; ") + "." }); return; }
      const sourceText = salesQuality === "missing" ? "" : salesQuality === "exact" ? sales : salesValue % 1000 === 0 ? `${salesValue / 1000}RB+` : `${salesValue}+`;
      previewRows.push({
        externalProductId: id,
        name,
        shopName: shop,
        ...(category ? { category } : {}),
        priceRupiah: priceValue,
        soldCount: {
          value: salesQuality === "missing" ? null : salesValue,
          quality: salesQuality as ShopeeSalesValue["quality"],
          sourceText,
        },
        reviewCount,
        ...(ratingText ? { ratingMilli } : {}),
        commissionRateBps: rateValue,
        commissionAmountRupiah: commissionValue,
        productUrl,
        affiliateUrl,
        ...(imageUrl ? { imageUrl } : {}),
        ...(videoUrl ? { videoUrl } : {}),
      });
    });
    if (previewErrors.length > 0) return { rows: [], errors: previewErrors };
    return { rows: previewRows, errors: [] };
  }
  const records = initialRecords;
  if (records.length === 0) return { rows: [], errors: [{ row: 1, message: "File CSV kosong." }] };
  const headers = records[0]!.map((header) => header.trim());
  const duplicateHeaders = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (duplicateHeaders.length > 0) {
    const uniqueDuplicates = [...new Set(duplicateHeaders)];
    return { rows: [], errors: [{ row: 1, message: `Header CSV duplikat: ${uniqueDuplicates.join(", ")}.` }] };
  }
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length > 0) return { rows: [], errors: [{ row: 1, message: `Kolom wajib tidak ditemukan: ${missing.join(", ")}.` }] };
  const indexes = new Map(headers.map((header, index) => [header, index]));
  const categoryHeaders = ["Kategori", "Kategori Produk", "category", "category_name"].filter((header) => indexes.has(header));
  if (categoryHeaders.length > 1) return { rows: [], errors: [{ row: 1, message: "Gunakan hanya satu kolom kategori agar sumber data tidak ambigu." }] };
  const ratingHeadersPresent = ["Rating", "Rating Produk", "Penilaian"].filter((header) => indexes.has(header));
  const reviewHeadersPresent = ["Jumlah Ulasan", "Ulasan", "Review Count"].filter((header) => indexes.has(header));
  if (ratingHeadersPresent.length > 1 || reviewHeadersPresent.length > 1) {
    return { rows: [], errors: [{ row: 1, message: "Gunakan hanya satu kolom rating dan satu kolom jumlah ulasan agar sumber data tidak ambigu." }] };
  }
  const rows: ParsedShopeeAffiliateCsvRow[] = [];
  const errors: ShopeeAffiliateCsvParseResult["errors"] = [];
  const seenIds = new Set<string>();
  records.slice(1).forEach((record, index) => {
    const rowNumber = index + 2;
    if (record.length !== headers.length) {
      errors.push({ row: rowNumber, message: `Jumlah kolom tidak sesuai: diharapkan ${headers.length}, ditemukan ${record.length}.` });
      return;
    }
    const get = (header: (typeof REQUIRED_HEADERS)[number]) => (record[indexes.get(header) ?? -1] ?? "").trim();
    const externalProductId = get("ID Produk");
    const name = get("Nama Produk");
    const priceRupiah = parseRupiah(get("Harga"));
    const commissionAmountRupiah = parseRupiah(get("Komisi"));
    const commissionRateBps = parseRateBps(get("Komisi hingga"));
    const soldCount = parseSales(get("Penjualan"));
    const productUrl = get("Link Produk");
    const affiliateUrl = get("Link Komisi Ekstra");
    const imageUrl = (record[indexes.get("Link Gambar") ?? indexes.get("image_url") ?? -1] ?? "").trim();
    const videoUrl = (record[indexes.get("Link Video") ?? indexes.get("video_url") ?? indexes.get("videoUrl") ?? -1] ?? "").trim();
    const category = categoryHeaders.length === 1 ? (record[indexes.get(categoryHeaders[0]!) ?? -1] ?? "").trim() : "";
    const ratingHeader = ["Rating", "Rating Produk", "Penilaian"].find((header) => indexes.has(header));
    const reviewHeader = ["Jumlah Ulasan", "Ulasan", "Review Count"].find((header) => indexes.has(header));
    const ratingText = ratingHeader ? (record[indexes.get(ratingHeader)!] ?? "").trim() : "";
    const reviewText = reviewHeader ? (record[indexes.get(reviewHeader)!] ?? "").trim() : "";
    const ratingMilli = ratingText ? parseRatingMilli(ratingText) : null;
    const reviewCount = parseSales(reviewText);
    const problems: string[] = [];
    if (!externalProductId) problems.push("ID Produk kosong");
    if (!name) problems.push("Nama Produk kosong");
    if (priceRupiah === null) problems.push("Harga tidak dapat dibaca");
    if (get("Penjualan") && soldCount.quality === "missing") problems.push("Penjualan tidak dapat dibaca");
    if (ratingText && ratingMilli === null) problems.push("Rating harus berupa angka antara 0 dan 5");
    if (reviewText && reviewCount.quality === "missing") problems.push("Jumlah ulasan tidak dapat dibaca");
    if (category.length > 120) problems.push("Kategori maksimal 120 karakter");
    if (commissionAmountRupiah === null && get("Komisi")) problems.push("Komisi tidak dapat dibaca");
    if (commissionRateBps === null && get("Komisi hingga")) problems.push("Persentase komisi tidak dapat dibaca");
    if (priceRupiah !== null && commissionAmountRupiah !== null && commissionAmountRupiah > priceRupiah) problems.push("Komisi tidak boleh melebihi harga produk");
    if (!isShopeeUrl(productUrl)) problems.push("Link Produk bukan URL HTTPS Shopee yang valid");
    if (!isShopeeUrl(affiliateUrl)) problems.push("Link Komisi Ekstra bukan URL HTTPS Shopee yang valid");
    if (imageUrl && !isHttpsMediaUrl(imageUrl)) problems.push("Link Gambar harus berupa URL HTTPS yang valid tanpa kredensial");
    if (videoUrl && !isHttpsMediaUrl(videoUrl)) problems.push("Link Video harus berupa URL HTTPS yang valid tanpa kredensial");
    if (externalProductId && seenIds.has(externalProductId)) problems.push("ID Produk duplikat dalam file");
    if (externalProductId) seenIds.add(externalProductId);
    if (problems.length > 0) { errors.push({ row: rowNumber, message: problems.join("; ") + "." }); return; }
    rows.push({ externalProductId, name, shopName: get("Nama Toko"), ...(category ? { category } : {}), priceRupiah: priceRupiah!, soldCount, reviewCount, ...(ratingMilli !== null ? { ratingMilli } : {}), commissionRateBps, commissionAmountRupiah, productUrl, affiliateUrl, ...(imageUrl ? { imageUrl } : {}), ...(videoUrl ? { videoUrl } : {}) });
  });
  return { rows, errors };
}
