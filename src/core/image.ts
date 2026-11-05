import sharp from "sharp";

sharp.cache(false);

export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
  channels: 1 | 3;
}

export type ImageInput = string | Buffer;

/** Load an image as raw gray or RGB pixels, optionally resized. */
export async function loadRaw(
  input: ImageInput,
  opts: { width?: number; height?: number; channels?: 1 | 3; fit?: "fill" | "inside" | "cover"; blur?: number } = {},
): Promise<RawImage> {
  const channels = opts.channels ?? 3;
  let img = sharp(input, { failOn: "none" }).removeAlpha();
  if (opts.width || opts.height) {
    img = img.resize({ width: opts.width, height: opts.height, fit: opts.fit ?? "fill", kernel: "lanczos3" });
  }
  if (opts.blur && opts.blur >= 0.3) img = img.blur(opts.blur);
  if (channels === 1) img = img.grayscale();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  // sharp may keep 3 channels for grayscale input; normalise.
  if (channels === 1 && info.channels !== 1) {
    const out = new Uint8Array(info.width * info.height);
    for (let i = 0, j = 0; i < out.length; i++, j += info.channels) out[i] = data[j];
    return { data: out, width: info.width, height: info.height, channels: 1 };
  }
  if (channels === 3 && info.channels === 1) {
    const out = new Uint8Array(info.width * info.height * 3);
    for (let i = 0; i < info.width * info.height; i++) out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = data[i];
    return { data: out, width: info.width, height: info.height, channels: 3 };
  }
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height, channels };
}

export async function imageSize(input: ImageInput): Promise<{ width: number; height: number }> {
  const m = await sharp(input).metadata();
  return { width: m.width ?? 0, height: m.height ?? 0 };
}

/** Resize a raw grayscale buffer with simple box sampling (fast, no sharp round-trip). */
export function resizeGray(src: Uint8Array, w: number, h: number, nw: number, nh: number): Uint8Array {
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor((y * h) / nh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / nh));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor((x * w) / nw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / nw));
      let s = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += src[yy * w + xx];
      out[y * nw + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

// ---------------------------------------------------------------- perceptual hash

const DCT_N = 32;
let dctCos: Float64Array | null = null;
function cosTable(): Float64Array {
  if (dctCos) return dctCos;
  dctCos = new Float64Array(DCT_N * DCT_N);
  for (let u = 0; u < DCT_N; u++) for (let x = 0; x < DCT_N; x++) dctCos[u * DCT_N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * DCT_N));
  return dctCos;
}

/** 64-bit DCT perceptual hash (pHash) of a grayscale buffer, as 16 hex chars. */
export function phashGray(gray: Uint8Array, w: number, h: number): string {
  const small = resizeGray(gray, w, h, DCT_N, DCT_N);
  const c = cosTable();
  const coeffs: number[] = [];
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < DCT_N; y++) {
        const cy = c[u * DCT_N + y];
        for (let x = 0; x < DCT_N; x++) s += small[y * DCT_N + x] * cy * c[v * DCT_N + x];
      }
      coeffs.push(s);
    }
  }
  const ac = coeffs.slice(1);
  const sorted = [...ac].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let bits = "";
  for (const v of coeffs) bits += v > median ? "1" : "0";
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

// ---------------------------------------------------------------- pixel diffs

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiffStats {
  /** Fraction of pixels that changed by more than the threshold. */
  changed: number;
  /** Mean absolute difference (0-255). */
  mafd: number;
  bbox: Box | null;
}

export function diffGray(a: Uint8Array, b: Uint8Array, w: number, h: number, threshold = 14, region?: Box): DiffStats {
  let changed = 0;
  let sum = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  const x0 = region?.x ?? 0;
  const y0 = region?.y ?? 0;
  const x1 = region ? region.x + region.w : w;
  const y1 = region ? region.y + region.h : h;
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = x0; x < x1; x++) {
      const d = Math.abs(a[row + x] - b[row + x]);
      sum += d;
      if (d > threshold) {
        changed++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const n = Math.max(1, (x1 - x0) * (y1 - y0));
  return {
    changed: changed / n,
    mafd: sum / n,
    bbox: maxX >= 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
  };
}

/** Binary mask of changed pixels. */
export function changeMask(a: Uint8Array, b: Uint8Array, threshold = 14): Uint8Array {
  const m = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) m[i] = Math.abs(a[i] - b[i]) > threshold ? 1 : 0;
  return m;
}

/** Connected components (8-neighbourhood) of a binary mask -> bounding boxes with pixel counts. */
export function components(mask: Uint8Array, w: number, h: number, minPixels = 1): Array<Box & { pixels: number }> {
  const labels = new Int32Array(w * h).fill(-1);
  const out: Array<Box & { pixels: number }> = [];
  const stack: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i] >= 0) continue;
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    let count = 0;
    stack.push(i);
    labels[i] = out.length;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p - x) / w;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && labels[q] < 0) {
            labels[q] = out.length;
            stack.push(q);
          }
        }
      }
    }
    if (count >= minPixels) out.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, pixels: count });
    else out.push({ x: -1, y: -1, w: 0, h: 0, pixels: 0 });
  }
  return out.filter((c) => c.pixels > 0);
}

/** Morphological dilation of a binary mask by radius r (square kernel, separable). */
export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    // two-pass sliding window
    let last = -Infinity;
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) last = x;
      if (x - last <= r) tmp[y * w + x] = 1;
    }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (mask[y * w + x]) last = x;
      if (last - x <= r) tmp[y * w + x] = 1;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) {
      if (tmp[y * w + x]) last = y;
      if (y - last <= r) out[y * w + x] = 1;
    }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) {
      if (tmp[y * w + x]) last = y;
      if (last - y <= r) out[y * w + x] = 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------- SSIM

/** Mean structural similarity of two equally sized grayscale buffers (8x8 windows, stride 4). */
export function ssim(a: Uint8Array, b: Uint8Array, w: number, h: number, win = 8, stride = 4): { mean: number; map: Float32Array; mapW: number; mapH: number } {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const mapW = Math.max(1, Math.floor((w - win) / stride) + 1);
  const mapH = Math.max(1, Math.floor((h - win) / stride) + 1);
  const map = new Float32Array(mapW * mapH);
  let total = 0;
  const n = win * win;
  for (let my = 0; my < mapH; my++) {
    for (let mx = 0; mx < mapW; mx++) {
      const x0 = mx * stride;
      const y0 = my * stride;
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      for (let y = y0; y < Math.min(h, y0 + win); y++) {
        for (let x = x0; x < Math.min(w, x0 + win); x++) {
          const va = a[y * w + x];
          const vb = b[y * w + x];
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      const ma = sa / n;
      const mb = sb / n;
      const va = saa / n - ma * ma;
      const vb = sbb / n - mb * mb;
      const cov = sab / n - ma * mb;
      const s = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      map[my * mapW + mx] = s;
      total += s;
    }
  }
  return { mean: total / map.length, map, mapW, mapH };
}

// ---------------------------------------------------------------- colour

export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x);
  y = f(y);
  z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function deltaE(l1: [number, number, number], l2: [number, number, number]): number {
  return Math.hypot(l1[0] - l2[0], l1[1] - l2[1], l1[2] - l2[2]);
}

export function hex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}

export function parseHex(h: string): [number, number, number] {
  const s = h.replace("#", "");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

export function luminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(...a);
  const lb = luminance(...b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function saturation(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
}

/** Crop a raw image (any channel count). */
export function cropRaw(img: RawImage, box: Box): RawImage {
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const w = Math.max(1, Math.min(img.width - x0, Math.round(box.w)));
  const h = Math.max(1, Math.min(img.height - y0, Math.round(box.h)));
  const c = img.channels;
  const out = new Uint8Array(w * h * c);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * c;
    out.set(img.data.subarray(src, src + w * c), y * w * c);
  }
  return { data: out, width: w, height: h, channels: img.channels };
}

export function toGray(img: RawImage): Uint8Array {
  if (img.channels === 1) return img.data;
  const out = new Uint8Array(img.width * img.height);
  for (let i = 0, j = 0; i < out.length; i++, j += 3) out[i] = (img.data[j] * 299 + img.data[j + 1] * 587 + img.data[j + 2] * 114) / 1000;
  return out;
}

/** Encode raw pixels with sharp. */
export function encodeRaw(img: RawImage, format: "png" | "jpeg" = "png"): Promise<Buffer> {
  const s = sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), {
    raw: { width: img.width, height: img.height, channels: img.channels },
  });
  return format === "png" ? s.png().toBuffer() : s.jpeg({ quality: 82 }).toBuffer();
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

/** Estimated vision tokens for an image (Claude-style ~ w*h/750). */
export function estimateImageTokens(width: number, height: number): number {
  return Math.ceil((width * height) / 750);
}
