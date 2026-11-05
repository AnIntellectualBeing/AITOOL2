import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { dominantColor, layoutBoxes, layoutScore, iou, type NormBox } from "../core/design.js";
import { RemakeError } from "../core/errors.js";
import { components, deltaE, dilate, escapeXml, hex, rgbToLab, ssim, toGray, type RawImage } from "../core/image.js";
import { ocrImage, stringSimilarity, textSimilarity, type OcrLine } from "../core/ocr.js";
import { ensureDir, workRoot } from "../core/paths.js";

export interface Crop {
  /** Fractions of the image height to drop (e.g. a phone status bar). */
  top?: number;
  bottom?: number;
}

export type FrameRef = string | { path: string; name?: string };

export interface CompareOptions {
  original: FrameRef[];
  build: FrameRef[];
  /** Crop applied to the original frames (e.g. watch_video's suggestedCrop). */
  crop?: Crop;
  /** Crop applied to build screenshots. */
  buildCrop?: Crop;
  threshold?: number;
  /** Every individual metric must reach this for a screen to pass (default 0.6). */
  minMetric?: number;
  pairing?: "auto" | "order" | "name" | "similarity";
  outDir?: string;
  ocr?: boolean;
}

export interface Mismatch {
  /** [x, y, w, h] normalised to the (cropped) original frame. */
  box: [number, number, number, number];
  severity: number;
  hint: string;
}

export interface PairResult {
  name: string;
  original: string;
  build: string;
  score: number;
  pass: boolean;
  metrics: { visual: number; layout: number; color: number; text: number };
  /** The metric dragging this screen down the most. */
  weakest: "visual" | "layout" | "color" | "text";
  mismatches: Mismatch[];
  text: { missing: string[]; extra: string[]; changed: Array<[string, string]> };
  diffImage: string;
  notes: string[];
}

export interface CompareResult {
  overall: number;
  threshold: number;
  passed: number;
  total: number;
  allPass: boolean;
  /** Worst first — fix these first. */
  pairs: PairResult[];
  unmatched: { original: string[]; build: string[] };
  reportPath: string;
}

const WORK_W = 360;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function refOf(f: FrameRef): { path: string; name: string } {
  const p = typeof f === "string" ? f : f.path;
  const name = typeof f === "string" ? path.basename(f).replace(/\.(png|jpe?g|webp)$/i, "") : f.name ?? path.basename(f.path).replace(/\.(png|jpe?g|webp)$/i, "");
  if (!existsSync(p)) throw new RemakeError("frame_missing", `Image not found: ${p}`);
  return { path: path.resolve(p), name };
}

/** State id inside a name: "s3", "s3-visit2", "03-s3", "s3-t001.250" -> "s3". */
export function stateKey(name: string): string | null {
  const m = name.match(/(?:^|[^a-z0-9])(s\d+)(?:$|[^0-9])/i) ?? name.match(/^(s\d+)/i);
  return m ? m[1].toLowerCase() : null;
}

interface Prepared {
  rgb: RawImage;
  gray: Uint8Array;
  small: RawImage;
  crop: { left: number; top: number; width: number; height: number };
  srcW: number;
  srcH: number;
}

async function prepare(file: string, crop: Crop | undefined, targetH?: number): Promise<Prepared> {
  const meta = await sharp(file).metadata();
  const W = meta.width ?? 1;
  const H = meta.height ?? 1;
  const top = Math.round((crop?.top ?? 0) * H);
  const bottom = Math.round((crop?.bottom ?? 0) * H);
  const c = { left: 0, top, width: W, height: Math.max(1, H - top - bottom) };
  const h = targetH ?? Math.round((WORK_W * c.height) / c.width);
  const base = sharp(file).removeAlpha().extract(c);
  const fitted = targetH
    ? base.resize({ width: WORK_W, height: h, fit: "cover", position: "top" })
    : base.resize({ width: WORK_W, height: h, fit: "fill" });
  const { data, info } = await fitted.raw().toBuffer({ resolveWithObject: true });
  const rgb: RawImage = { data: new Uint8Array(data), width: info.width, height: info.height, channels: 3 };
  const smallBuf = await sharp(Buffer.from(rgb.data), { raw: { width: rgb.width, height: rgb.height, channels: 3 } })
    .resize({ width: 72, height: Math.max(1, Math.round((72 * rgb.height) / rgb.width)), fit: "fill" })
    .blur(0.8)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    rgb,
    gray: toGray(rgb),
    small: { data: new Uint8Array(smallBuf.data), width: smallBuf.info.width, height: smallBuf.info.height, channels: 3 },
    crop: c,
    srcW: W,
    srcH: H,
  };
}

async function grayBlurHalf(img: RawImage): Promise<{ data: Uint8Array; w: number; h: number }> {
  const w = Math.round(img.width / 2);
  const h = Math.round(img.height / 2);
  const out = await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 3 } })
    .resize({ width: w, height: h, fit: "fill" })
    .grayscale()
    .blur(0.6)
    .raw()
    .toBuffer();
  return { data: new Uint8Array(out), w, h };
}

function colorScore(a: RawImage, b: RawImage): number {
  let sum = 0;
  const n = Math.min(a.data.length, b.data.length) / 3;
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    sum += deltaE(rgbToLab(a.data[j], a.data[j + 1], a.data[j + 2]), rgbToLab(b.data[j], b.data[j + 1], b.data[j + 2]));
  }
  return clamp01(1 - sum / n / 12);
}

async function ocrCropped(file: string, c: Prepared["crop"]): Promise<OcrLine[]> {
  const buf = await sharp(file).removeAlpha().extract(c).png().toBuffer();
  return (await ocrImage(buf)).filter((l) => !/^[0oOQ@°\s]+$/.test(l.text));
}

function textDiff(a: OcrLine[], b: OcrLine[]) {
  const used = new Set<number>();
  const missing: string[] = [];
  const changed: Array<[string, string]> = [];
  for (const la of a) {
    let best = -1;
    let bestSim = 0;
    b.forEach((lb, j) => {
      if (used.has(j)) return;
      const s = stringSimilarity(la.text, lb.text);
      if (s > bestSim) {
        bestSim = s;
        best = j;
      }
    });
    if (best >= 0 && bestSim >= 0.82) used.add(best);
    else if (best >= 0 && bestSim >= 0.45) {
      used.add(best);
      changed.push([la.text, b[best].text]);
    } else missing.push(la.text);
  }
  const extra = b.filter((_, j) => !used.has(j)).map((l) => l.text);
  return { missing, extra, changed };
}

/** Normalised OCR line boxes relative to a crop. */
function normLines(lines: OcrLine[], c: Prepared["crop"]): Array<{ text: string; box: NormBox }> {
  return lines.map((l) => ({ text: l.text, box: { x: l.box.x / c.width, y: l.box.y / c.height, w: l.box.w / c.width, h: l.box.h / c.height } }));
}

function overlaps(a: NormBox, b: NormBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

async function comparePair(
  o: { path: string; name: string },
  b: { path: string; name: string },
  opts: CompareOptions,
  outDir: string,
  index: number,
): Promise<PairResult> {
  const notes: string[] = [];
  const po = await prepare(o.path, opts.crop);
  const pb = await prepare(b.path, opts.buildCrop, po.rgb.height);
  const aspectO = po.crop.height / po.crop.width;
  const aspectB = pb.crop.height / pb.crop.width;
  if (Math.abs(aspectO - aspectB) / aspectO > 0.08) {
    notes.push(`Aspect ratio differs (original ${aspectO.toFixed(2)}, build ${aspectB.toFixed(2)}): build was top-aligned. Use a viewport matching the recording (cssViewport) and pass suggestedCrop.`);
  }
  // Visual similarity (SSIM on a softened half-size copy, to ignore video compression).
  const go = await grayBlurHalf(po.rgb);
  const gb = await grayBlurHalf(pb.rgb);
  const ss = ssim(go.data, gb.data, go.w, go.h);
  const visual = clamp01((ss.structured - 0.25) / 0.65);
  // Layout
  const lo = await layoutBoxes(po.rgb);
  const lb = await layoutBoxes(pb.rgb);
  const lay = layoutScore(lo.boxes, lb.boxes);
  // Colour
  const color = colorScore(po.small, pb.small);
  // Text
  let text = 1;
  let td = { missing: [] as string[], extra: [] as string[], changed: [] as Array<[string, string]> };
  let linesO: Array<{ text: string; box: NormBox }> = [];
  let linesB: Array<{ text: string; box: NormBox }> = [];
  if (opts.ocr !== false) {
    const ocrO = await ocrCropped(o.path, po.crop);
    const ocrB = await ocrCropped(b.path, pb.crop);
    text = textSimilarity(ocrO.map((l) => l.text).join(" "), ocrB.map((l) => l.text).join(" "));
    td = textDiff(ocrO, ocrB);
    linesO = normLines(ocrO, po.crop);
    linesB = normLines(ocrB, pb.crop);
    if (!ocrO.length && !ocrB.length) text = 1;
  }
  const hasText = linesO.length + linesB.length > 0;
  const score = hasText ? 0.3 * visual + 0.25 * lay.score + 0.2 * color + 0.25 * text : 0.4 * visual + 0.33 * lay.score + 0.27 * color;

  // Mismatch regions: per-pixel colour difference on blurred images.
  const W = po.rgb.width;
  const H = po.rgb.height;
  const blurO = await sharp(Buffer.from(po.rgb.data), { raw: { width: W, height: H, channels: 3 } }).blur(1.5).raw().toBuffer();
  const blurB = await sharp(Buffer.from(pb.rgb.data), { raw: { width: W, height: H, channels: 3 } }).blur(1.5).raw().toBuffer();
  const cw = Math.ceil(W / 4);
  const chh = Math.ceil(H / 4);
  const cell = new Float32Array(cw * chh);
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 3;
      const d = deltaE(rgbToLab(blurO[i], blurO[i + 1], blurO[i + 2]), rgbToLab(blurB[i], blurB[i + 1], blurB[i + 2]));
      const ci = Math.floor(y / 4) * cw + Math.floor(x / 4);
      cell[ci] = Math.max(cell[ci], d);
    }
  }
  const mask = new Uint8Array(cw * chh);
  for (let i = 0; i < cell.length; i++) mask[i] = cell[i] > 14 ? 1 : 0;
  const regions = components(dilate(mask, cw, chh, 2), cw, chh, 4)
    .map((c) => {
      let mass = 0;
      for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) mass += mask[y * cw + x] ? cell[y * cw + x] : 0;
      return { box: { x: c.x / cw, y: c.y / chh, w: c.w / cw, h: c.h / chh }, mass };
    })
    .sort((a, b) => b.mass - a.mass)
    .slice(0, 6);
  const totalMass = regions.reduce((s, r) => s + r.mass, 0) || 1;
  const mismatches: Mismatch[] = regions.map((r) => {
    const hints: string[] = [];
    const tO = linesO.filter((l) => overlaps(l.box, r.box)).map((l) => l.text);
    const tB = linesB.filter((l) => overlaps(l.box, r.box)).map((l) => l.text);
    const missing = tO.filter((t) => !tB.some((u) => stringSimilarity(t, u) > 0.82));
    const extra = tB.filter((t) => !tO.some((u) => stringSimilarity(t, u) > 0.82));
    if (missing.length && extra.length) hints.push(`text differs: ${JSON.stringify(missing.slice(0, 2).join(" / "))} → ${JSON.stringify(extra.slice(0, 2).join(" / "))}`);
    else if (missing.length) hints.push(`missing text ${JSON.stringify(missing.slice(0, 3).join(" / "))}`);
    else if (extra.length) hints.push(`extra text ${JSON.stringify(extra.slice(0, 3).join(" / "))}`);
    const px = { x: Math.floor(r.box.x * W), y: Math.floor(r.box.y * H), w: Math.max(1, Math.ceil(r.box.w * W)), h: Math.max(1, Math.ceil(r.box.h * H)) };
    const cO = dominantColor(po.rgb, px);
    const cB = dominantColor(pb.rgb, px);
    if (deltaE(rgbToLab(...cO), rgbToLab(...cB)) > 10) hints.push(`colour ${hex(...cO)} in original vs ${hex(...cB)} in build`);
    const bo = lo.boxes.filter((x) => overlaps(x, r.box) && x.w * x.h > 0.002);
    const bb = lb.boxes.filter((x) => overlaps(x, r.box) && x.w * x.h > 0.002);
    if (bo.length && !bb.length) hints.push("element missing in build");
    else if (!bo.length && bb.length) hints.push("extra element in build");
    else if (bo.length && bb.length) {
      const best = Math.max(...bo.map((x) => Math.max(...bb.map((y) => iou(x, y)))));
      if (best < 0.6) hints.push("size/position differs");
    }
    if (!hints.length) hints.push("visual difference (icon, image, shadow or border)");
    return { box: [r3(r.box.x), r3(r.box.y), r3(r.box.w), r3(r.box.h)], severity: r3(r.mass / totalMass), hint: hints.join("; ") };
  });

  // Diff image: original | build | build with mismatch boxes
  const diffImage = path.join(outDir, `${String(index + 1).padStart(2, "0")}-${o.name.replace(/[^a-z0-9_-]+/gi, "-")}-diff.jpg`);
  const panel = (img: RawImage) => sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 3 } }).png().toBuffer();
  const gap = 10;
  const labelH = 26;
  const boxesSvg = mismatches
    .map((m, k) => {
      const [x, y, w, h] = m.box;
      return `<rect x="${x * W}" y="${y * H}" width="${w * W}" height="${h * H}" fill="rgba(255,0,60,0.12)" stroke="#ff1744" stroke-width="2.5"/><circle cx="${x * W + 9}" cy="${y * H + 9}" r="9" fill="#ff1744"/><text x="${x * W + 9}" y="${y * H + 13}" font-size="12" font-family="Helvetica, Arial, sans-serif" fill="#fff" text-anchor="middle">${k + 1}</text>`;
    })
    .join("");
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${boxesSvg}</svg>`);
  const marked = await sharp(await panel(pb.rgb)).composite([{ input: overlay }]).png().toBuffer();
  const label = (t: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${labelH}"><text x="4" y="18" font-size="15" font-family="Helvetica, Arial, sans-serif" fill="#eee">${escapeXml(t)}</text></svg>`);
  await sharp({ create: { width: W * 3 + gap * 4, height: H + labelH + gap, channels: 3, background: "#111114" } })
    .composite([
      { input: label(`Original · ${o.name}`), left: gap, top: 2 },
      { input: label(`Build · ${b.name}`), left: W + gap * 2, top: 2 },
      { input: label(`Score ${Math.round(score * 100)} · biggest differences`), left: W * 2 + gap * 3, top: 2 },
      { input: await panel(po.rgb), left: gap, top: labelH },
      { input: await panel(pb.rgb), left: W + gap * 2, top: labelH },
      { input: marked, left: W * 2 + gap * 3, top: labelH },
    ])
    .jpeg({ quality: 80 })
    .toFile(diffImage);

  const metrics = { visual: r3(visual), layout: r3(lay.score), color: r3(color), text: r3(text) };
  const weakest = (Object.keys(metrics) as Array<keyof typeof metrics>).reduce((a, k) => (metrics[k] < metrics[a] ? k : a), "visual" as keyof typeof metrics);
  return {
    name: stateKey(o.name) ?? o.name,
    original: o.path,
    build: b.path,
    score: r3(score),
    // A screen passes when the combined score clears the threshold AND no single aspect is badly off.
    pass: score >= (opts.threshold ?? 0.85) && metrics[weakest] >= (opts.minMetric ?? 0.6),
    metrics,
    weakest,
    mismatches,
    text: { missing: td.missing.slice(0, 12), extra: td.extra.slice(0, 12), changed: td.changed.slice(0, 12) },
    diffImage,
    notes,
  };
}

async function quickSim(a: string, b: string): Promise<number> {
  const pa = await prepare(a, undefined);
  const pb = await prepare(b, undefined, pa.rgb.height);
  return colorScore(pa.small, pb.small);
}

/** Pair original frames with build screenshots (by state name, order, or visual similarity). */
export async function pairFrames(original: FrameRef[], build: FrameRef[], mode: CompareOptions["pairing"] = "auto") {
  const O = original.map(refOf);
  const Bs = build.map(refOf);
  const pairs: Array<[number, number]> = [];
  const byName = () => {
    const keyO = O.map((o) => stateKey(o.name));
    Bs.forEach((b, j) => {
      const k = stateKey(b.name);
      const i = k ? keyO.indexOf(k) : -1;
      if (i >= 0) pairs.push([i, j]);
    });
  };
  if (mode === "name" || mode === "auto") byName();
  if (mode === "order" || (mode === "auto" && pairs.length === 0 && O.length === Bs.length)) {
    pairs.length = 0;
    for (let i = 0; i < Math.min(O.length, Bs.length); i++) pairs.push([i, i]);
  }
  if (mode === "similarity" || (mode === "auto" && pairs.length === 0)) {
    const cand: Array<[number, number, number]> = [];
    for (let i = 0; i < O.length; i++) for (let j = 0; j < Bs.length; j++) cand.push([i, j, await quickSim(O[i].path, Bs[j].path)]);
    cand.sort((a, b) => b[2] - a[2]);
    const ui = new Set<number>();
    const uj = new Set<number>();
    for (const [i, j] of cand) {
      if (ui.has(i) || uj.has(j)) continue;
      ui.add(i);
      uj.add(j);
      pairs.push([i, j]);
    }
  }
  return { O, B: Bs, pairs };
}

/** Score how closely build screenshots match the original video's frames, screen by screen. */
export async function compare(opts: CompareOptions): Promise<CompareResult> {
  if (!opts.original?.length || !opts.build?.length) throw new RemakeError("nothing_to_compare", "compare needs at least one original frame and one build screenshot.");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = ensureDir(opts.outDir ? path.resolve(opts.outDir) : path.join(workRoot(), "compare", stamp));
  const { O, B, pairs } = await pairFrames(opts.original, opts.build, opts.pairing);
  const results: PairResult[] = [];
  for (const [k, [i, j]] of pairs.entries()) results.push(await comparePair(O[i], B[j], opts, outDir, k));
  const threshold = opts.threshold ?? 0.85;
  const usedO = new Set(pairs.map((p) => p[0]));
  const usedB = new Set(pairs.map((p) => p[1]));
  const unmatched = { original: O.filter((_, i) => !usedO.has(i)).map((o) => o.name), build: B.filter((_, j) => !usedB.has(j)).map((b) => b.name) };
  // Unmatched originals count as failed screens.
  const scores = [...results.map((r) => r.score), ...unmatched.original.map(() => 0)];
  const overall = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  results.sort((a, b) => a.score - b.score);
  const res: CompareResult = {
    overall: r3(overall),
    threshold,
    passed: results.filter((r) => r.pass).length,
    total: results.length + unmatched.original.length,
    allPass: results.every((r) => r.pass) && unmatched.original.length === 0,
    pairs: results,
    unmatched,
    reportPath: path.join(outDir, "compare.json"),
  };
  writeFileSync(res.reportPath, JSON.stringify(res, null, 2));
  return res;
}
