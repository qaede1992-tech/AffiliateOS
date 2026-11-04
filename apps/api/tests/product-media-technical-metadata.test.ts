import assert from "node:assert/strict";
import test from "node:test";
import { extractProductMediaTechnicalMetadata } from "../src/domain/product-media-technical-metadata.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l0sAAAAASUVORK5CYII=", "base64");
const box = (type: string, payload: Uint8Array): Uint8Array => {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(Buffer.from(type), 4);
  out.set(payload, 8);
  return out;
};
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const makeMp4 = (): Uint8Array => {
  const ftyp = box("ftyp", Uint8Array.from([105,115,111,109,0,0,0,0]));
  const mdat = box("mdat", Uint8Array.from([1]));
  const mvhdPayload = new Uint8Array(20);
  new DataView(mvhdPayload.buffer).setUint32(12, 1000);
  new DataView(mvhdPayload.buffer).setUint32(16, 12000);
  const mvhd = box("mvhd", mvhdPayload);
  const tkhdPayload = new Uint8Array(84);
  new DataView(tkhdPayload.buffer).setUint32(76, 720 * 65536);
  new DataView(tkhdPayload.buffer).setUint32(80, 1280 * 65536);
  const tkhd = box("tkhd", tkhdPayload);
  const videoMdia = box("mdia", box("hdlr", Uint8Array.from([0,0,0,0,0,0,0,0,118,105,100,101])));
  const videoTrak = box("trak", concat(tkhd, videoMdia));
  const audioHandler = box("hdlr", Uint8Array.from([0,0,0,0,0,0,0,0,115,111,117,110]));
  const audioTrak = box("trak", box("mdia", audioHandler));
  return concat(ftyp, mdat, box("moov", concat(mvhd, videoTrak, audioTrak)));
};

test("extracts PNG dimensions without trusting filename or remote metadata", () => {
  assert.deepEqual(extractProductMediaTechnicalMetadata("image/png", png), {
    width: 1, height: 1, durationMs: null, hasAudio: null
  });
});

test("extracts MP4 frame dimensions, duration, and audio-track presence from container boxes", () => {
  assert.deepEqual(extractProductMediaTechnicalMetadata("video/mp4", makeMp4()), {
    width: 720, height: 1280, durationMs: 12000, hasAudio: true
  });
});

test("returns unknown metadata for structurally incomplete MP4 containers", () => {
  assert.deepEqual(extractProductMediaTechnicalMetadata("video/mp4", new Uint8Array([0,0,0,8,109,111,111,118])), {
    width: null, height: null, durationMs: null, hasAudio: null
  });
});


test("keeps audio-track metadata unknown when an MP4 track has no readable handler", () => {
  const ftyp = box("ftyp", Uint8Array.from([105,115,111,109,0,0,0,0]));
  const mdat = box("mdat", Uint8Array.from([1]));
  const mvhdPayload = new Uint8Array(20);
  new DataView(mvhdPayload.buffer).setUint32(12, 1000);
  new DataView(mvhdPayload.buffer).setUint32(16, 12000);
  const tkhdPayload = new Uint8Array(84);
  new DataView(tkhdPayload.buffer).setUint32(76, 720 * 65536);
  new DataView(tkhdPayload.buffer).setUint32(80, 1280 * 65536);
  const trak = box("trak", box("tkhd", tkhdPayload));
  const bytes = concat(ftyp, mdat, box("moov", concat(box("mvhd", mvhdPayload), trak)));
  assert.equal(extractProductMediaTechnicalMetadata("video/mp4", bytes).hasAudio, null);
});

test("does not infer an absent audio track when an MP4 track handler is unreadable", () => {
  const ftyp = box("ftyp", Uint8Array.from([105,115,111,109,0,0,0,0]));
  const mdat = box("mdat", Uint8Array.from([1]));
  const mvhdPayload = new Uint8Array(20);
  new DataView(mvhdPayload.buffer).setUint32(12, 1000);
  new DataView(mvhdPayload.buffer).setUint32(16, 12000);
  const malformedTrack = box("trak", box("tkhd", new Uint8Array(84)));
  const file = concat(ftyp, mdat, box("moov", concat(box("mvhd", mvhdPayload), malformedTrack)));
  assert.equal(extractProductMediaTechnicalMetadata("video/mp4", file).hasAudio, null);
});

test("uses video-track dimensions rather than dimensions from a non-video track", () => {
  const ftyp = box("ftyp", Uint8Array.from([105,115,111,109,0,0,0,0]));
  const mdat = box("mdat", Uint8Array.from([1]));
  const mvhdPayload = new Uint8Array(20);
  new DataView(mvhdPayload.buffer).setUint32(12, 1000);
  new DataView(mvhdPayload.buffer).setUint32(16, 12000);
  const makeTrack = (handler: string, width: number, height: number) => {
    const tkhdPayload = new Uint8Array(84);
    new DataView(tkhdPayload.buffer).setUint32(76, width * 65536);
    new DataView(tkhdPayload.buffer).setUint32(80, height * 65536);
    const handlerPayload = Uint8Array.from([0,0,0,0,0,0,0,0,...Buffer.from(handler)]);
    return box("trak", concat(box("tkhd", tkhdPayload), box("mdia", box("hdlr", handlerPayload))));
  };
  const file = concat(ftyp, mdat, box("moov", concat(
    box("mvhd", mvhdPayload),
    makeTrack("meta", 100, 100),
    makeTrack("vide", 720, 1280)
  )));
  const metadata = extractProductMediaTechnicalMetadata("video/mp4", file);
  assert.equal(metadata.width, 720);
  assert.equal(metadata.height, 1280);
});
