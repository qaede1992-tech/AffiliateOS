export type ShopeeSalesValue = {
  value: number | null;
  quality: "exact" | "lower_bound" | "missing";
  sourceText: string;
};

export type ParsedShopeeAffiliateCsvRow = {
  externalProductId: string;
  name: string;
  shopName: string;
  priceRupiah: number;
  soldCount: ShopeeSalesValue;
  commissionRateBps: number | null;
  commissionAmountRupiah: number | null;
  productUrl: string;
  affiliateUrl: string;
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
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field.length === 0) quoted = true;
    else if (char === ",") { record.push(field); field = ""; }
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
  if (abbreviated) {
    const amount = Number(abbreviated[1].replace(",", "."));
    return Number.isFinite(amount) ? Math.round(amount * 1000) : null;
  }
  if (!/^\d[\d.]*$/.test(normalized)) return null;
  const amount = Number(normalized.replace(/\./g, ""));
  return Number.isSafeInteger(amount) ? amount : null;
}

function parseRateBps(value: string): number | null {
  const normalized = value.trim().replace(/%$/, "").replace(",", ".");
  if (!normalized) return null;
  const rate = Number(normalized);
  return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? Math.round(rate * 100) : null;
}

function parseSales(value: string): ShopeeSalesValue {
  const sourceText = value.trim();
  const normalized = sourceText.toUpperCase().replace(/\s/g, "");
  if (!normalized) return { value: null, quality: "missing", sourceText };
  const approximate = normalized.match(/^(\d+(?:[.,]\d+)?)RB\+?$/);
  if (approximate) {
    const count = Number(approximate[1].replace(",", ".")) * 1000;
    return { value: Number.isSafeInteger(Math.round(count)) ? Math.round(count) : null, quality: "lower_bound", sourceText };
  }
  if (!/^\d[\d.]*$/.test(normalized)) return { value: null, quality: "missing", sourceText };
  const count = Number(normalized.replace(/\./g, ""));
  return { value: Number.isSafeInteger(count) ? count : null, quality: "exact", sourceText };
}

function isShopeeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "shopee.co.id" || host === "s.shopee.co.id" || host === "shopee.ee" || host === "shope.ee" || host.endsWith(".shopee.co.id"));
  } catch { return false; }
}

/** Parses the CSV export from Shopee's mass affiliate-link tool; performs no persistence or URL fetching. */
export function parseShopeeAffiliateCsv(input: string): ShopeeAffiliateCsvParseResult {
  const records = parseCsvRecords(input);
  if (records.length === 0) return { rows: [], errors: [{ row: 1, message: "File CSV kosong." }] };
  const headers = records[0]!.map((header) => header.trim());
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length > 0) return { rows: [], errors: [{ row: 1, message: `Kolom wajib tidak ditemukan: ${missing.join(", ")}.` }] };
  const indexes = new Map(headers.map((header, index) => [header, index]));
  const rows: ParsedShopeeAffiliateCsvRow[] = [];
  const errors: ShopeeAffiliateCsvParseResult["errors"] = [];
  const seenIds = new Set<string>();
  records.slice(1).forEach((record, index) => {
    const rowNumber = index + 2;
    const get = (header: (typeof REQUIRED_HEADERS)[number]) => (record[indexes.get(header) ?? -1] ?? "").trim();
    const externalProductId = get("ID Produk");
    const name = get("Nama Produk");
    const priceRupiah = parseRupiah(get("Harga"));
    const productUrl = get("Link Produk");
    const affiliateUrl = get("Link Komisi Ekstra");
    const problems: string[] = [];
    if (!externalProductId) problems.push("ID Produk kosong");
    if (!name) problems.push("Nama Produk kosong");
    if (priceRupiah === null) problems.push("Harga tidak dapat dibaca");
    if (!isShopeeUrl(productUrl)) problems.push("Link Produk bukan URL HTTPS Shopee yang valid");
    if (!isShopeeUrl(affiliateUrl)) problems.push("Link Komisi Ekstra bukan URL HTTPS Shopee yang valid");
    if (externalProductId && seenIds.has(externalProductId)) problems.push("ID Produk duplikat dalam file");
    if (problems.length > 0) { errors.push({ row: rowNumber, message: problems.join("; ") + "." }); return; }
    seenIds.add(externalProductId);
    rows.push({ externalProductId, name, shopName: get("Nama Toko"), priceRupiah: priceRupiah!, soldCount: parseSales(get("Penjualan")), commissionRateBps: parseRateBps(get("Komisi hingga")), commissionAmountRupiah: parseRupiah(get("Komisi")), productUrl, affiliateUrl });
  });
  return { rows, errors };
}
