const readAscii = (bytes: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(start, start + length));

const isPng = (bytes: Uint8Array): boolean => {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || !signature.every((value, index) => bytes[index] === value)) return false;
  let offset = 8;
  let hasHeader = false;
  let hasData = false;
  while (offset + 12 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const type = readAscii(bytes, offset + 4, 4);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    if (!hasHeader) {
      if (type !== "IHDR" || length !== 13) return false;
      const width = new DataView(bytes.buffer, bytes.byteOffset + offset + 8, 4).getUint32(0);
      const height = new DataView(bytes.buffer, bytes.byteOffset + offset + 12, 4).getUint32(0);
      if (width === 0 || height === 0) return false;
      hasHeader = true;
    } else if (type === "IHDR") return false;
    if (type === "IDAT" && length > 0) hasData = true;
    offset = end;
    if (type === "IEND") return length === 0 && hasHeader && hasData && offset === bytes.length;
  }
  return false;
};

const isJpeg = (bytes: Uint8Array): boolean => {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return false;
  let offset = 2;
  let hasFrame = false;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return hasFrame && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return false;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) return false;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (width === 0 || height === 0) return false;
      hasFrame = true;
    }
    offset += length;
  }
  return false;
};

const isWebp = (bytes: Uint8Array): boolean => {
  if (bytes.length < 20 || readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WEBP") return false;
  const declaredSize = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true);
  if (declaredSize !== bytes.length - 8) return false;
  let offset = 12;
  let hasImageChunk = false;
  while (offset + 8 <= bytes.length) {
    const type = readAscii(bytes, offset, 4);
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    const end = offset + 8 + length + (length % 2);
    if (end > bytes.length) return false;
    if (["VP8 ", "VP8L", "VP8X"].includes(type) && length > 0) hasImageChunk = true;
    offset = end;
  }
  return offset === bytes.length && hasImageChunk;
};

const isMp4 = (bytes: Uint8Array): boolean => {
  if (bytes.length < 16) return false;
  let offset = 0;
  let hasFtyp = false;
  let hasMediaOrMovie = false;
  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
    let size = view.getUint32(0);
    const type = readAscii(bytes, offset + 4, 4);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) return false;
      const high = new DataView(bytes.buffer, bytes.byteOffset + offset + 8, 4).getUint32(0);
      const low = new DataView(bytes.buffer, bytes.byteOffset + offset + 12, 4).getUint32(0);
      if (high !== 0) return false;
      size = low;
      header = 16;
    } else if (size === 0) size = bytes.length - offset;
    if (size < header || offset + size > bytes.length) return false;
    if (type === "ftyp" && size >= header + 8) hasFtyp = true;
    if ((type === "mdat" && size > header) || (type === "moov" && size > header)) hasMediaOrMovie = true;
    offset += size;
  }
  return offset === bytes.length && hasFtyp && hasMediaOrMovie;
};

export const isStructurallyValidMedia = (mimeType: string, bytes: Uint8Array): boolean => {
  if (!(bytes instanceof Uint8Array)) return false;
  if (mimeType === "image/png") return isPng(bytes);
  if (mimeType === "image/jpeg") return isJpeg(bytes);
  if (mimeType === "image/webp") return isWebp(bytes);
  if (mimeType === "video/mp4") return isMp4(bytes);
  return false;
};
