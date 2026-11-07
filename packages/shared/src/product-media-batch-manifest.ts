export type ProductMediaBatchKind = "image" | "video";

export interface ProductMediaBatchManifestRow {
  externalProductId: string;
  fileName: string;
  kind: ProductMediaBatchKind;
  lineNumber: number;
}

export class ProductMediaBatchManifestError extends Error {
  constructor(
    readonly code: "EMPTY_FILE" | "INVALID_CSV" | "MISSING_COLUMN" | "DUPLICATE_COLUMN" | "INVALID_ROW" | "DUPLICATE_MAPPING" | "TOO_MANY_ROWS",
    message: string
  ) {
    super(message);
    this.name = "ProductMediaBatchManifestError";
  }
}

const parseCsvRows = (source: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  let line = 1;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += character;
        if (character === "\n") line += 1;
        else if (character === "\r" && source[index + 1] !== "\n") line += 1;
      }
      continue;
    }

    if (afterQuote) {
      if (character === "," ) {
        row.push(field);
        field = "";
        afterQuote = false;
        continue;
      }
      if (character === "\r" || character === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        afterQuote = false;
        if (character === "\r" && source[index + 1] === "\n") index += 1;
        line += 1;
        continue;
      }
      if (character === " " || character === "\t") continue;
      throw new ProductMediaBatchManifestError("INVALID_CSV", `CSV memiliki karakter setelah tanda kutip pada baris ${line}.`);
    }

    if (character === '"') {
      if (field.length !== 0) {
        throw new ProductMediaBatchManifestError("INVALID_CSV", `Tanda kutip tidak valid pada baris ${line}.`);
      }
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\r" || character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      line += 1;
    } else {
      field += character;
    }
  }

  if (quoted) throw new ProductMediaBatchManifestError("INVALID_CSV", "CSV memiliki tanda kutip yang belum ditutup.");
  if (field.length > 0 || row.length > 0 || afterQuote) {
    row.push(field);
    rows.push(row);
  }
  return rows;
};

/**
 * Parse an explicit user-authored manifest. It maps exact uploaded file names to
 * Shopee external product IDs; it never resolves or downloads remote media URLs.
 */
export function parseProductMediaBatchManifest(source: string, maxRows = 200): ProductMediaBatchManifestRow[] {
  const normalized = source.replace(/^\uFEFF/, "");
  if (!normalized.trim()) throw new ProductMediaBatchManifestError("EMPTY_FILE", "File CSV pemetaan media kosong.");

  const records = parseCsvRows(normalized);
  const header = records.shift()?.map((value) => value.trim().toLocaleLowerCase("en-US")) ?? [];
  const required = ["externalproductid", "filename", "kind"] as const;
  for (const column of required) {
    if (!header.includes(column)) {
      throw new ProductMediaBatchManifestError("MISSING_COLUMN", `Kolom wajib "${column}" tidak ditemukan.`);
    }
  }
  if (new Set(header).size !== header.length) {
    throw new ProductMediaBatchManifestError("DUPLICATE_COLUMN", "Header CSV memiliki nama kolom duplikat.");
  }

  const positions = {
    externalProductId: header.indexOf("externalproductid"),
    fileName: header.indexOf("filename"),
    kind: header.indexOf("kind")
  };
  const rows: ProductMediaBatchManifestRow[] = [];
  const mappings = new Set<string>();
  const fileNames = new Set<string>();

  records.forEach((record, index) => {
    const lineNumber = index + 2;
    if (record.every((value) => !value.trim())) return;
    const externalProductId = (record[positions.externalProductId] ?? "").trim();
    const fileName = (record[positions.fileName] ?? "").trim();
    const kind = (record[positions.kind] ?? "").trim().toLocaleLowerCase("en-US");
    if (!externalProductId || externalProductId.length > 128 || !fileName || fileName.length > 255
      || fileName === "." || fileName === ".." || /[\\/\u0000-\u001f]/.test(fileName)
      || (kind !== "image" && kind !== "video")) {
      throw new ProductMediaBatchManifestError("INVALID_ROW", `Pemetaan media pada baris ${lineNumber} tidak valid.`);
    }
    const mappingKey = `${externalProductId}\u0000${fileName}`;
    if (mappings.has(mappingKey) || fileNames.has(fileName)) {
      throw new ProductMediaBatchManifestError("DUPLICATE_MAPPING", `Produk atau nama file terpetakan lebih dari sekali pada baris ${lineNumber}.`);
    }
    mappings.add(mappingKey);
    fileNames.add(fileName);
    rows.push({ externalProductId, fileName, kind, lineNumber });
  });

  if (rows.length === 0) throw new ProductMediaBatchManifestError("INVALID_ROW", "CSV tidak berisi baris pemetaan media.");
  if (rows.length > maxRows) {
    throw new ProductMediaBatchManifestError("TOO_MANY_ROWS", `Maksimal ${maxRows} file media dapat diproses dalam satu batch.`);
  }
  return rows;
}
