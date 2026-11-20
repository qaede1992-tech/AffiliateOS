import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { hasWebmEbmlSignature, transcodeWebmToMp4 } from "../src/domain/webm-to-mp4-transcoder.js";
import { ProductMediaIngestionService } from "../src/domain/product-media-ingestion.js";

const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x86, 0x81, 0x01]);
const mp4 = Uint8Array.from([
  0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
  0, 0, 0, 9, 0x6d, 0x64, 0x61, 0x74, 1
]);

test("recognizes only the WebM EBML signature", () => {
  assert.equal(hasWebmEbmlSignature(webm), true);
  assert.equal(hasWebmEbmlSignature(new Uint8Array([0, 0, 0, 0])), false);
});

test("transcodes a bounded local WebM input and validates the MP4 output", async () => {
  let invoked = false;
  let observedArgs: string[] = [];
  let observedTimeout = 0;
  const output = await transcodeWebmToMp4(webm, {
    maxInputBytes: 1024,
    maxOutputBytes: 1024,
    maxDurationSeconds: 20,
    timeoutMs: 5_000,
    runProcess: async (_binary, args, timeoutMs) => {
      invoked = true;
      observedArgs = args;
      observedTimeout = timeoutMs;
      await writeFile(args.at(-1)!, mp4, { flag: "wx" });
    }
  });
  assert.equal(invoked, true);
  assert.deepEqual(output, mp4);
  assert.equal(observedTimeout, 5_000);
  assert.ok(observedArgs.includes("-protocol_whitelist"));
  assert.ok(observedArgs.includes("file,pipe"));
  assert.ok(observedArgs.includes("-threads"));
  assert.ok(observedArgs.includes("-t"));
  assert.ok(observedArgs.includes("-fs"));
  assert.equal(observedArgs.includes("https://"), false);
});

test("rejects non-WebM input before starting FFmpeg", async () => {
  let invoked = false;
  await assert.rejects(() => transcodeWebmToMp4(new Uint8Array([1, 2, 3, 4]), {
    maxInputBytes: 1024,
    runProcess: async () => { invoked = true; }
  }), /WebM\/EBML signature/);
  assert.equal(invoked, false);
});

test("rejects output exceeding the configured size limit", async () => {
  await assert.rejects(() => transcodeWebmToMp4(webm, {
    maxInputBytes: 1024,
    maxOutputBytes: 8,
    runProcess: async (_binary, args) => {
      await writeFile(args.at(-1)!, mp4, { flag: "wx" });
    }
  }), /exceeds the configured output size limit/);
});

test("ingestion stores converted WebM as MP4 without changing rights or provenance status", async () => {
  const uploads: Array<{ contentType: string; bytes: Uint8Array }> = [];
  const saved: Array<Record<string, unknown>> = [];
  const storage = {
    upload: async (input: { key: string; contentType: string; bytes: Uint8Array }) => {
      uploads.push({ contentType: input.contentType, bytes: input.bytes });
      return { bucket: "affiliate-media", key: input.key };
    },
    remove: async () => {}
  } as never;
  const repository = {
    findByProductAndHash: async () => undefined,
    save: async (asset: Record<string, unknown>) => { saved.push(asset); return asset; }
  } as never;
  const fetcher = (async () => ({ status: 200, headers: {}, url: "https://upload.wikimedia.org/sample.webm", bytes: webm })) as never;
  const transcoder = (async () => mp4) as never;
  const service = new ProductMediaIngestionService(
    storage,
    repository,
    { maxImageBytes: 1024, maxVideoBytes: 1024 },
    fetcher,
    transcoder
  );
  const result = await service.ingest({
    productId: "462d1fd3-46d4-4832-a812-0b538ebd8144",
    nonMediaEligibilityPassed: true,
    candidates: [{
      kind: "video",
      url: "https://upload.wikimedia.org/sample.webm",
      source: "catalog",
      provenance: {
        provider: "wikimedia_commons",
        candidateId: "22222222-2222-4222-8222-222222222222",
        landingPageUrl: "https://commons.wikimedia.org/wiki/File:sample.webm",
        title: "Sample WebM",
        query: "sample product",
        creator: "Creator",
        creatorUrl: null,
        license: "CC-BY-SA",
        licenseVersion: "4.0",
        licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
        sourcePublisher: "Wikimedia Commons"
      }
    }]
  });

  assert.equal(result.stored.length, 1);
  assert.equal(result.skipped.length, 0);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]?.contentType, "video/mp4");
  assert.deepEqual(uploads[0]?.bytes, mp4);
  assert.equal(saved[0]?.mimeType, "video/mp4");
  assert.equal(saved[0]?.sourceUrl, "https://upload.wikimedia.org/sample.webm");
  assert.equal(saved[0]?.sourceProvider, "wikimedia_commons");
  assert.equal(saved[0]?.sourceCandidateId, "22222222-2222-4222-8222-222222222222");
  assert.equal(saved[0]?.rightsStatus, "unverified");
  assert.equal(saved[0]?.rightsBasis, null);
});
