import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { hasWebmEbmlSignature, transcodeWebmToMp4 } from "../src/domain/webm-to-mp4-transcoder.js";

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
