import {
  components,
  contrastRatio,
  deltaE,
  dilate,
  hex,
  loadRaw,
  rgbToLab,
  saturation,
  type Box,
  type ImageInput,
  type RawImage,
} from "./image.js";
import type { OcrLine } from "./ocr.js";

export interface NormBox {
  /** 0..1 relative to image width/height. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutResult {
  width: number;
  height: number;
  background: string;
  /** Top-level UI blocks (cards, bars, buttons, text runs), normalised 0..1. */
  boxes: NormBox[];
}

function colorDist(d: Uint8Array, i: number, bg: [number, number, number]): number {
  const dr = d[i] - bg[0];
  const dg = d[i + 1] - bg[1];
  const db = d[i + 2] - bg[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

export function dominantColor(img: RawImage, region?: Box): [number, number, number] {
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  const x0 = region?.x ?? 0;
  const y0 = region?.y ?? 0;
  const x1 = region ? Math.min(img.width, region.x + region.w) : img.width;
  const y1 = region ? Math.min(img.height, region.y + region.h) : img.height;
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 20000)));
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * img.width + x) * 3;
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const e = counts.get(key);
      if (e) {
        e.n++;
        e.r += r;
        e.g += g;
        e.b += b;
      } else counts.set(key, { n: 1, r, g, b });
    }
  }
  let best = { n: 0, r: 255, g: 255, b: 255 };
  for (const e of counts.values()) if (e.n > best.n) best = e;
  return best.n ? [best.r / best.n, best.g / best.n, best.b / best.n] : [255, 255, 255];
}

/** Find the top-level layout blocks of a UI screenshot. */
export async function layoutBoxes(input: ImageInput | RawImage, opts: { width?: number } = {}): Promise<LayoutResult> {
  const width = opts.width ?? 360;
  const img: RawImage = isRaw(input) ? input : await loadRaw(input, { width, fit: "inside", channels: 3 });
  const W = img.width;
  const H = img.height;
  const bg = dominantColor(img);
  const mask = new Uint8Array(W * H);
  for (let p = 0, i = 0; p < W * H; p++, i += 3) mask[p] = colorDist(img.data, i, bg) > 22 ? 1 : 0;
  const grown = dilate(mask, W, H, Math.max(2, Math.round(W / 110)));
  const comps = components(grown, W, H, Math.max(12, Math.round((W * H) / 8000)));
  const boxes = comps
    .filter((c) => c.w * c.h < W * H * 0.9 && c.w >= 3 && c.h >= 3)
    .map((c) => ({ x: c.x / W, y: c.y / H, w: c.w / W, h: c.h / H }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  return { width: W, height: H, background: hex(...bg), boxes };
}

function isRaw(x: unknown): x is RawImage {
  return typeof x === "object" && x !== null && "data" in x && "channels" in x && !Buffer.isBuffer(x);
}

export function iou(a: NormBox, b: NormBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

/** Area-weighted F-score of matched boxes (greedy IoU matching). 1 = same layout. */
export function layoutScore(a: NormBox[], b: NormBox[]): { score: number; matched: Array<[number, number, number]>; missing: number[]; extra: number[] } {
  if (!a.length && !b.length) return { score: 1, matched: [], missing: [], extra: [] };
  const pairs: Array<[number, number, number]> = [];
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    const v = iou(a[i], b[j]);
    if (v > 0.05) pairs.push([i, j, v]);
  }
  pairs.sort((p, q) => q[2] - p[2]);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const matched: Array<[number, number, number]> = [];
  for (const [i, j, v] of pairs) {
    if (usedA.has(i) || usedB.has(j)) continue;
    usedA.add(i);
    usedB.add(j);
    matched.push([i, j, v]);
  }
  // Weight each box by sqrt(area) so tiny specks don't dominate.
  const wA = a.map((x) => Math.sqrt(x.w * x.h));
  const wB = b.map((x) => Math.sqrt(x.w * x.h));
  const totA = wA.reduce((s, v) => s + v, 0);
  const totB = wB.reduce((s, v) => s + v, 0);
  let hit = 0;
  for (const [i, j, v] of matched) hit += ((wA[i] + wB[j]) / 2) * v;
  const score = totA + totB > 0 ? (2 * hit) / (totA + totB) : 1;
  return {
    score: Math.max(0, Math.min(1, score)),
    matched,
    missing: a.map((_, i) => i).filter((i) => !usedA.has(i)),
    extra: b.map((_, j) => j).filter((j) => !usedB.has(j)),
  };
}

// ------------------------------------------------------------------ palette

export interface PaletteColor {
  hex: string;
  share: number;
}

export interface Palette {
  colors: PaletteColor[];
  roles: { background?: string; surface?: string; text?: string; mutedText?: string; accent?: string; border?: string };
}

interface Cluster {
  n: number;
  r: number;
  g: number;
  b: number;
  lab: [number, number, number];
}

function cluster(buckets: Iterable<{ n: number; r: number; g: number; b: number }>, maxDelta = 7): Cluster[] {
  const sorted = [...buckets].sort((a, b) => b.n - a.n);
  const out: Cluster[] = [];
  for (const e of sorted) {
    const c: [number, number, number] = [e.r / e.n, e.g / e.n, e.b / e.n];
    const lab = rgbToLab(...c);
    const near = out.find((o) => deltaE(o.lab, lab) < maxDelta);
    if (near) {
      near.n += e.n;
      near.r += e.r;
      near.g += e.g;
      near.b += e.b;
    } else out.push({ n: e.n, r: e.r, g: e.g, b: e.b, lab });
  }
  for (const o of out) o.lab = rgbToLab(o.r / o.n, o.g / o.n, o.b / o.n);
  return out.sort((a, b) => b.n - a.n);
}

const rgbOf = (c: Cluster): [number, number, number] => [c.r / c.n, c.g / c.n, c.b / c.n];
const hexToRgb = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];

/** Colour tokens across a set of screens, with guessed roles (background, text, accent...). */
export async function extractPalette(
  images: Array<{ input: ImageInput; ocr?: OcrLine[]; scale?: number }>,
  opts: { cropTop?: number; cropBottom?: number } = {},
): Promise<Palette> {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  const textBuckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  // Saturated pixels on their own: accents (buttons, links, toggles) often cover <1% of a screen.
  const satBuckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  const add = (m: typeof buckets, r: number, g: number, b: number, w = 1) => {
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = m.get(key);
    if (e) {
      e.n += w;
      e.r += r * w;
      e.g += g * w;
      e.b += b * w;
    } else m.set(key, { n: w, r: r * w, g: g * w, b: b * w });
  };
  for (const im of images) {
    const img = await loadRaw(im.input, { width: 240, fit: "inside", channels: 3 });
    const y0 = Math.round((opts.cropTop ?? 0) * img.height);
    const y1 = Math.round((1 - (opts.cropBottom ?? 0)) * img.height);
    for (let y = y0; y < y1; y++) for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 3;
      add(buckets, img.data[i], img.data[i + 1], img.data[i + 2]);
      if (saturation(img.data[i], img.data[i + 1], img.data[i + 2]) > 0.4 && Math.max(img.data[i], img.data[i + 1], img.data[i + 2]) > 60) add(satBuckets, img.data[i], img.data[i + 1], img.data[i + 2]);
    }
    if (im.ocr?.length) {
      const full = await loadRaw(im.input, { channels: 3 });
      for (const line of im.ocr) {
        const b = line.box;
        if (b.w < 4 || b.h < 4) continue;
        const local = dominantColor(full, b);
        const step = Math.max(1, Math.floor(Math.sqrt((b.w * b.h) / 1500)));
        for (let y = b.y; y < Math.min(full.height, b.y + b.h); y += step) for (let x = b.x; x < Math.min(full.width, b.x + b.w); x += step) {
          const i = (y * full.width + x) * 3;
          if (colorDist(full.data, i, local) > 90) add(textBuckets, full.data[i], full.data[i + 1], full.data[i + 2]);
        }
      }
    }
  }
  const clusters = cluster(buckets.values());
  const total = clusters.reduce((s, c) => s + c.n, 0) || 1;
  const colors = clusters
    .filter((c) => c.n / total >= 0.002)
    .slice(0, 12)
    .map((c) => ({ hex: hex(...rgbOf(c)), share: Math.round((c.n / total) * 1000) / 1000 }));
  const roles: Palette["roles"] = {};
  if (clusters[0]) {
    const bg = clusters[0];
    roles.background = hex(...rgbOf(bg));
    const surface = clusters.slice(1).find((c) => c.n / total > 0.03 && deltaE(c.lab, bg.lab) < 30 && deltaE(c.lab, bg.lab) > 2);
    if (surface) roles.surface = hex(...rgbOf(surface));
    const border = clusters.slice(1).find((c) => c !== surface && c.n / total > 0.004 && deltaE(c.lab, bg.lab) > 4 && deltaE(c.lab, bg.lab) < 18 && saturation(...rgbOf(c)) < 0.2);
    if (border) roles.border = hex(...rgbOf(border));
    const tclusters = cluster(textBuckets.values(), 12);
    const textCands = (tclusters.length ? tclusters : clusters)
      .filter((c) => contrastRatio(rgbOf(c), rgbOf(bg)) > 2.5 && saturation(...rgbOf(c)) < 0.35)
      .slice(0, 4);
    // The main text colour is the highest-contrast common one; muted text is the next distinct one.
    const tTotal = textCands.reduce((s2, c) => s2 + c.n, 0) || 1;
    const common = textCands.filter((c) => c.n / tTotal > 0.12);
    const main = [...common].sort((a, b) => contrastRatio(rgbOf(b), rgbOf(bg)) - contrastRatio(rgbOf(a), rgbOf(bg)))[0];
    if (main) {
      roles.text = hex(...rgbOf(main));
      const muted = common.find((c) => c !== main && deltaE(c.lab, main.lab) > 12);
      if (muted) roles.mutedText = hex(...rgbOf(muted));
    }
    const sat = cluster(satBuckets.values(), 10).filter((c) => c.n / total > 0.0005);
    const accent = sat[0];
    if (accent) {
      roles.accent = hex(...rgbOf(accent));
      if (!colors.some((c) => deltaE(rgbToLab(...hexToRgb(c.hex)), accent.lab) < 10)) {
        colors.push({ hex: roles.accent, share: Math.round((accent.n / total) * 1000) / 1000 });
      }
    }
  }
  return { colors, roles };
}

// ------------------------------------------------------------------ type scale & spacing

const ASC = /[A-Z0-9bdfhiklt!?%#&@$]/;
const DESC = /[gjpqy,;]/;

/** Estimated font size (px) from an OCR word box height. */
export function fontSizeFromBox(text: string, h: number): number {
  const asc = ASC.test(text);
  const desc = DESC.test(text);
  const ratio = asc && desc ? 0.96 : asc ? 0.74 : desc ? 0.74 : 0.54;
  return h / ratio;
}

export interface TypeLevel {
  sizePx: number;
  count: number;
  sample: string;
}

export function typeScale(lines: OcrLine[], cssScale: number): TypeLevel[] {
  const sizes: Array<{ size: number; text: string }> = [];
  for (const l of lines) {
    const ws = (l.words?.length ? l.words : [{ text: l.text, box: l.box, confidence: l.confidence }]).filter((w) => w.text.length >= 2);
    if (!ws.length) continue;
    const est = ws.map((w) => fontSizeFromBox(w.text, w.box.h)).sort((a, b) => a - b);
    sizes.push({ size: est[Math.floor(est.length / 2)] / cssScale, text: l.text });
  }
  sizes.sort((a, b) => b.size - a.size);
  const levels: Array<{ sizes: number[]; samples: string[] }> = [];
  for (const s of sizes) {
    const lvl = levels.find((l) => Math.abs(l.sizes[0] - s.size) / l.sizes[0] < 0.12);
    if (lvl) {
      lvl.sizes.push(s.size);
      lvl.samples.push(s.text);
    } else levels.push({ sizes: [s.size], samples: [s.text] });
  }
  return levels
    .map((l) => {
      const sorted = [...l.sizes].sort((a, b) => a - b);
      return { sizePx: Math.round(sorted[Math.floor(sorted.length / 2)]), count: l.sizes.length, sample: l.samples[0].slice(0, 40) };
    })
    .filter((l) => l.sizePx >= 6 && l.sizePx <= 120)
    .sort((a, b) => b.sizePx - a.sizePx);
}

export interface Spacing {
  baseUnit: number;
  commonGapsPx: number[];
  commonInsetsPx: number[];
}

function topValues(values: number[], k: number): number[] {
  const counts = new Map<number, number>();
  for (const v of values) {
    const r = Math.round(v / 2) * 2;
    if (r <= 0 || r > 200) continue;
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, k)
    .map((e) => e[0])
    .sort((a, b) => a - b);
}

/** Approximate spacing scale (CSS px) from layout boxes of several screens. */
export function spacingFrom(layouts: LayoutResult[], cssWidth: number): Spacing {
  const gaps: number[] = [];
  const insets: number[] = [];
  for (const L of layouts) {
    const px = (v: number) => v * cssWidth;
    const pxH = (v: number) => v * cssWidth * (L.height / L.width);
    const boxes = L.boxes.filter((b) => b.w * b.h > 0.0005);
    for (const b of boxes) {
      if (b.x > 0.005) insets.push(px(b.x));
      if (b.x + b.w < 0.995) insets.push(px(1 - b.x - b.w));
    }
    for (let i = 0; i < boxes.length; i++) {
      // nearest box below that overlaps horizontally
      let best = Infinity;
      for (let j = 0; j < boxes.length; j++) {
        if (i === j) continue;
        const a = boxes[i];
        const b = boxes[j];
        const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        if (overlap <= 0) continue;
        const g = b.y - (a.y + a.h);
        if (g > 0.001 && g < best) best = g;
      }
      if (best < 0.3 && pxH(best) >= 4) gaps.push(pxH(best));
    }
  }
  const all = [...gaps, ...insets].filter((v) => v > 1);
  const fit = (u: number) => all.filter((v) => Math.abs(v / u - Math.round(v / u)) * u <= 1.5).length / Math.max(1, all.length);
  const baseUnit = fit(8) >= 0.6 ? 8 : 4;
  return { baseUnit, commonGapsPx: topValues(gaps, 5), commonInsetsPx: topValues(insets, 4) };
}
