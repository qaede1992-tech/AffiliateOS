import assert from "node:assert/strict";
import test from "node:test";
import { parseProductMediaBatchManifest, ProductMediaBatchManifestError } from "@affiliateos/shared";

test("parses a UTF-8 BOM manifest with reordered columns, quoted commas and CRLF", () => {
  const rows = parseProductMediaBatchManifest(
    "\uFEFFkind,filename,externalProductId\r\nimage,\"front, angle.jpg\",SP-100\r\nvideo,clip.mp4,SP-100\r\n"
  );
  assert.deepEqual(rows, [
    { externalProductId: "SP-100", fileName: "front, angle.jpg", kind: "image", lineNumber: 2 },
    { externalProductId: "SP-100", fileName: "clip.mp4", kind: "video", lineNumber: 3 }
  ]);
});

test("rejects missing headers, malformed quoting, invalid rows and duplicate file mappings", () => {
  assert.throws(() => parseProductMediaBatchManifest("product,file,kind\nSP-1,a.jpg,image"), ProductMediaBatchManifestError);
  assert.throws(() => parseProductMediaBatchManifest("externalProductId,filename,kind\nSP-1,\"a.jpg,image"), /kutip yang belum ditutup/i);
  assert.throws(() => parseProductMediaBatchManifest("externalProductId,filename,kind\nSP-1,../a.jpg,image"), /tidak valid/i);
  assert.throws(() => parseProductMediaBatchManifest("externalProductId,filename,kind\nSP-1,a.jpg,image\nSP-2,a.jpg,image"), /lebih dari sekali/i);
});

test("rejects unsupported media kinds and excessive batch sizes", () => {
  assert.throws(() => parseProductMediaBatchManifest("externalProductId,filename,kind\nSP-1,a.gif,animation"), /tidak valid/i);
  assert.throws(() => parseProductMediaBatchManifest("externalProductId,filename,kind\nSP-1,a.jpg,image\nSP-2,b.jpg,image", 1), /Maksimal 1/i);
});
