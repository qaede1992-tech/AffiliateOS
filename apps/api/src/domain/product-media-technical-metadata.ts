export interface ProductMediaTechnicalMetadata {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  hasAudio: boolean | null;
}

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

const uint32 = (bytes: Uint8Array, offset: number, littleEndian = false): number =>
  new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, littleEndian);

const imageDimensions = (mimeType: string, bytes: Uint8Array): { width: number; height: number } | undefined => {
  if (mimeType === "image/png" && bytes.length >= 24) {
    return { width: uint32(bytes, 16), height: uint32(bytes, 20) };
  }
  if (mimeType === "image/jpeg") {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return undefined;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
      if (length < 2 || offset + length > bytes.length) return undefined;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (length < 8) return undefined;
        return { height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!, width: (bytes[offset + 5]! << 8) | bytes[offset + 6]! };
      }
      offset += length;
    }
    return undefined;
  }
  if (mimeType === "image/webp" && bytes.length >= 30) {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const type = ascii(bytes, offset, 4);
      const length = uint32(bytes, offset + 4, true);
      const data = offset + 8;
      if (data + length > bytes.length) return undefined;
      if (type === "VP8X" && length >= 10) {
        return {
          width: 1 + bytes[data + 4]! + (bytes[data + 5]! << 8) + (bytes[data + 6]! << 16),
          height: 1 + bytes[data + 7]! + (bytes[data + 8]! << 8) + (bytes[data + 9]! << 16)
        };
      }
      if (type === "VP8 " && length >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
        return { width: ((bytes[data + 7]! & 0x3f) << 8) | bytes[data + 6]!, height: ((bytes[data + 9]! & 0x3f) << 8) | bytes[data + 8]! };
      }
      if (type === "VP8L" && length >= 5 && bytes[data] === 0x2f) {
        const b1 = bytes[data + 2]!, b2 = bytes[data + 3]!, b3 = bytes[data + 4]!;
        return { width: 1 + bytes[data + 1]! + ((b1 & 0x3f) << 8), height: 1 + ((b1 & 0xc0) >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10) };
      }
      offset = data + length + (length % 2);
    }
  }
  return undefined;
};

interface Mp4Box { type: string; start: number; data: number; end: number; }
const boxes = (bytes: Uint8Array, start: number, end: number): Mp4Box[] => {
  const result: Mp4Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = uint32(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      const high = uint32(bytes, offset + 8);
      const low = uint32(bytes, offset + 12);
      if (high !== 0) break;
      size = low;
      header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) break;
    result.push({ type, start: offset, data: offset + header, end: offset + size });
    offset += size;
  }
  return result;
};

const descendants = (bytes: Uint8Array, parent: Mp4Box, path: string[]): Mp4Box | undefined => {
  let current = [parent];
  for (const type of path) {
    const next: Mp4Box[] = [];
    for (const box of current) next.push(...boxes(bytes, box.data, box.end).filter((child) => child.type === type));
    current = next;
    if (current.length === 0) return undefined;
  }
  return current[0];
};

const mp4Metadata = (bytes: Uint8Array): ProductMediaTechnicalMetadata => {
  const top = boxes(bytes, 0, bytes.length);
  const moov = top.find((box) => box.type === "moov");
  if (!moov) return { width: null, height: null, durationMs: null, hasAudio: null };
  const mvhd = boxes(bytes, moov.data, moov.end).find((box) => box.type === "mvhd");
  let durationMs: number | null = null;
  if (mvhd) {
    const version = bytes[mvhd.data] ?? 0;
    const timescaleOffset = mvhd.data + (version === 1 ? 20 : 12);
    const durationOffset = mvhd.data + (version === 1 ? 24 : 16);
    if (durationOffset + (version === 1 ? 8 : 4) <= mvhd.end) {
      const timescale = uint32(bytes, timescaleOffset);
      const duration = version === 1
        ? Number(new DataView(bytes.buffer, bytes.byteOffset + durationOffset, 8).getBigUint64(0))
        : uint32(bytes, durationOffset);
      if (timescale > 0 && Number.isSafeInteger(duration) && duration > 0) durationMs = Math.round(duration / timescale * 1000);
    }
  }
  let width: number | null = null;
  let height: number | null = null;
  const tracks = boxes(bytes, moov.data, moov.end).filter((box) => box.type === "trak");
  let hasAudio: boolean | null = tracks.length > 0 ? false : null;
  for (const trak of tracks) {
    const hdlr = descendants(bytes, trak, ["mdia", "hdlr"]);
    if (hdlr && hdlr.data + 12 <= hdlr.end && ascii(bytes, hdlr.data + 8, 4) === "soun") hasAudio = true;
    const tkhd = boxes(bytes, trak.data, trak.end).find((box) => box.type === "tkhd");
    if (!tkhd || tkhd.end - tkhd.data < 8) continue;
    const candidateWidth = uint32(bytes, tkhd.end - 8) / 65536;
    const candidateHeight = uint32(bytes, tkhd.end - 4) / 65536;
    if (candidateWidth > 0 && candidateHeight > 0 && width === null) {
      width = Math.round(candidateWidth);
      height = Math.round(candidateHeight);
    }
  }
  return { width, height, durationMs, hasAudio };
};

export const extractProductMediaTechnicalMetadata = (
  mimeType: string,
  bytes: Uint8Array
): ProductMediaTechnicalMetadata => {
  if (mimeType === "video/mp4") return mp4Metadata(bytes);
  const dimensions = imageDimensions(mimeType, bytes);
  return {
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    durationMs: null,
    hasAudio: null
  };
};
