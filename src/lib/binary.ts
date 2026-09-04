/* ============================================================
   sparkBook · src/lib/binary.ts
   Base64 ⇄ bytes helpers shared by the binary document surfaces
   (image viewer, image editor, PDF reader).

   Documents in those modes keep base64 in `OpenDoc.raw` because
   the store, the workspace snapshot and the host bridge all speak
   strings. These helpers are the only place that conversion
   happens, so the encoding assumption stays in one file.
   ============================================================ */

/** Decode a base64 string to bytes. Tolerates data-URI prefixes and whitespace. */
export function base64ToBytes(b64: string): Uint8Array {
  const payload = stripDataUri(b64).replace(/\s+/g, "");
  const bin = atob(payload);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode bytes as base64. Chunked so large buffers do not blow the
    argument limit of `String.fromCharCode`. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Drop a leading `data:<mime>;base64,` prefix if present. */
export function stripDataUri(s: string): string {
  const comma = s.indexOf(",");
  return s.startsWith("data:") && comma !== -1 ? s.slice(comma + 1) : s;
}

/** Build a `data:` URL from base64 payload and a MIME type. */
export function dataUri(base64: string, mime: string): string {
  return `data:${mime};base64,${stripDataUri(base64)}`;
}

/**
 * Create an object URL for base64 bytes. Object URLs beat data URIs for
 * large payloads: the webview does not have to parse a multi-megabyte
 * string on every render. Callers must revoke the URL when done.
 */
export function base64ToObjectUrl(base64: string, mime: string): string {
  const blob = new Blob([base64ToBytes(base64) as unknown as BlobPart], { type: mime });
  return URL.createObjectURL(blob);
}

/** Byte length of a base64 payload without decoding it. */
export function base64ByteLength(base64: string): number {
  const s = stripDataUri(base64).replace(/\s+/g, "");
  if (!s) return 0;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}

/** Human-readable byte count: 1.4 MB, 812 kB, 96 B. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["kB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Pull the base64 payload out of a canvas `toDataURL` result. */
export function canvasToBase64(canvas: HTMLCanvasElement, mime: string, quality?: number): string {
  return stripDataUri(canvas.toDataURL(mime, quality));
}

/** Load an HTMLImageElement from a URL, resolving once it has decoded. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image could not be decoded"));
    img.src = src;
  });
}
