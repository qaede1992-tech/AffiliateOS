import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { IllustrativeProductVideoRenderer } from "../../src/domain/illustrative-product-video-renderer.js";

const validMp4 = new Uint8Array([
  0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 112, 52, 0, 0,
  0, 0, 0, 9, 109, 100, 97, 116, 1
]);
const validProbe = JSON.stringify({
  streams: [{ codec_type: "video", codec_name: "h264", width: 720, height: 1280, pix_fmt: "yuv420p" }],
  format: { duration: "12.000000" }
});

test("renders a text-and-graphics MP4 without product images, network, or storage", async () => {
  let ffmpegArgs: string[] = [];
  let probedPath = "";
  const renderer = new IllustrativeProductVideoRenderer({
    timeoutMs: 10_000,
    runProcess: async (_binary, args, timeoutMs) => {
      assert.equal(timeoutMs, 10_000);
      ffmpegArgs = args;
      assert.ok(args.includes("libx264"));
      assert.ok(args.includes("-an"));
      assert.ok(args.includes("-f"));
      assert.ok(args.includes("lavfi"));
      assert.ok(!args.some((arg) => /^https?:\/\//i.test(arg)));
      await writeFile(args[args.length - 1]!, validMp4);
    },
    probeProcess: async (_binary, args) => {
      probedPath = args[args.length - 1]!;
      return validProbe;
    }
  });

  const result = await renderer.render({
    productName: "Produk ilustrasi tanpa foto",
    priceCents: 125000,
    currency: "IDR"
  });
  assert.equal(result.metadata.width, 720);
  assert.equal(result.metadata.height, 1280);
  assert.equal(result.metadata.durationMs, 12_000);
  assert.equal(result.metadata.codec, "h264");
  assert.equal(result.metadata.mimeType, "video/mp4");
  assert.equal(result.bytes.byteLength, validMp4.byteLength);
  assert.equal(result.metadata.byteSize, validMp4.byteLength);
  assert.equal(result.metadata.sha256.length, 64);
  assert.ok(ffmpegArgs.some((arg) => arg.includes("drawbox")));
  assert.ok(ffmpegArgs.some((arg) => arg.includes("textfile=")));
  assert.ok(probedPath.endsWith("illustrative-promo.mp4"));
});

test("keeps untrusted product names in a text file rather than FFmpeg filter syntax", async () => {
  let title = "";
  let filter = "";
  const renderer = new IllustrativeProductVideoRenderer({
    runProcess: async (_binary, args) => {
      filter = args[args.indexOf("-vf") + 1]!;
      const titlePath = filter.match(/textfile=([^:,]+)/)?.[1];
      assert.ok(titlePath);
      title = await readFile(titlePath, "utf8");
      await writeFile(args[args.length - 1]!, validMp4);
    },
    probeProcess: async () => validProbe
  });
  const untrustedName = "Produk';drawtext=text='INJECTED'\nNama\u0000 Aman";
  await renderer.render({ productName: untrustedName, priceCents: 9900, currency: "IDR" });
  assert.ok(!filter.includes("INJECTED"));
  assert.ok(!title.includes("\u0000"));
  assert.ok(title.includes("Produk';drawtext=text='INJECTED'"));
});

test("rejects FFprobe output that does not prove the expected playable video properties", async () => {
  const renderer = new IllustrativeProductVideoRenderer({
    runProcess: async (_binary, args) => { await writeFile(args[args.length - 1]!, validMp4); },
    probeProcess: async () => JSON.stringify({
      streams: [{ codec_type: "video", codec_name: "mpeg4", width: 720, height: 1280, pix_fmt: "yuv420p" }],
      format: { duration: "12" }
    })
  });
  await assert.rejects(
    renderer.render({ productName: "Produk", priceCents: 1000, currency: "IDR" }),
    /failed codec, resolution, pixel-format, or duration verification/
  );
});

test("rejects invalid product facts before invoking FFmpeg", async () => {
  let renders = 0;
  const renderer = new IllustrativeProductVideoRenderer({
    runProcess: async () => { renders++; },
    probeProcess: async () => validProbe
  });
  await assert.rejects(renderer.render({ productName: "", priceCents: 1000, currency: "IDR" }), /name is required/);
  await assert.rejects(renderer.render({ productName: "Produk", priceCents: -1, currency: "IDR" }), /non-negative safe integer/);
  await assert.rejects(renderer.render({ productName: "Produk", priceCents: 1000, currency: "idr" }), /uppercase ISO code/);
  assert.equal(renders, 0);
});
