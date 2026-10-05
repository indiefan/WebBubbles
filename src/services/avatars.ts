// Contact photos.
//
// The server returns every contact's picture as base64. Many of those are not
// photos at all but generated letter tiles, which are dropped so that such
// contacts get the app's own initials like everyone else without a photo.

/** Avatars are shown at 48 CSS px at most; this covers high-density displays. */
const MAX_EDGE = 160;
/** Pictures larger than this are shrunk before being kept in memory. */
const RESIZE_ABOVE_BYTES = 24 * 1024;
const ANALYSIS_EDGE = 24;
/** A generated tile is one flat colour with a letter on it. */
const TILE_DOMINANT_SHARE = 0.8;
/** Without image analysis, anything this small is assumed to be a tile. */
const TILE_MAX_BYTES = 2048;

export function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  const tag = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && tag === 'WEBP') return 'image/webp';
  return null;
}

/**
 * The share of an image taken up by its single most common colour, with
 * colours bucketed coarsely so compression noise doesn't split one flat area.
 *
 * @param rgba pixel data, 4 bytes per pixel
 */
export function dominantColorShare(rgba: Uint8ClampedArray | Uint8Array): number {
  const counts = new Map<number, number>();
  let max = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const key = ((rgba[i] >> 4) << 8) | ((rgba[i + 1] >> 4) << 4) | (rgba[i + 2] >> 4);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > max) max = n;
  }
  const pixels = rgba.length / 4;
  return pixels > 0 ? max / pixels : 0;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Turn a contact picture from the server into a data URL ready for an <img>,
 * or null when there is no usable photo.
 *
 * @param keepTiles keep pictures that look generated. Set for sources where
 *   every picture was chosen by the user.
 */
export async function prepareAvatar(base64: string | null | undefined, keepTiles = false): Promise<string | null> {
  if (!base64) return null;

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(base64);
  } catch {
    return null;
  }
  const type = sniffImageType(bytes);
  if (!type) return null;
  const asIs = `data:${type};base64,${base64}`;

  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    return keepTiles || bytes.length > TILE_MAX_BYTES ? asIs : null;
  }

  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type }));
    try {
      if (!keepTiles) {
        const probe = new OffscreenCanvas(ANALYSIS_EDGE, ANALYSIS_EDGE);
        const ctx = probe.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0, ANALYSIS_EDGE, ANALYSIS_EDGE);
          const { data } = ctx.getImageData(0, 0, ANALYSIS_EDGE, ANALYSIS_EDGE);
          if (dominantColorShare(data) >= TILE_DOMINANT_SHARE) return null;
        }
      }

      const longest = Math.max(bitmap.width, bitmap.height);
      if (bytes.length <= RESIZE_ABOVE_BYTES || longest <= MAX_EDGE) return asIs;

      const scale = MAX_EDGE / longest;
      const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return asIs;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      // JPEG has no transparency, so PNGs (Memoji on a clear background) stay PNG
      const outType = type === 'image/png' ? 'image/png' : 'image/jpeg';
      const blob = await canvas.convertToBlob({ type: outType, quality: 0.85 });
      return `data:${outType};base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
    } finally {
      bitmap.close();
    }
  } catch {
    // Not decodable here (e.g. HEIC): nothing an <img> could show either
    return null;
  }
}
