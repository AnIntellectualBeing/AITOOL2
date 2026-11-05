import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";
import { RemakeError } from "./errors.js";
import { ensureDir, remakeHome } from "./paths.js";

export interface OcrLine {
  text: string;
  /** Box in the source image's pixel coordinates. */
  box: { x: number; y: number; w: number; h: number };
  confidence: number;
  words?: Array<{ text: string; box: { x: number; y: number; w: number; h: number }; confidence: number }>;
}

type Worker = {
  recognize: (img: Buffer, opts?: unknown, output?: unknown) => Promise<{ data: any }>;
  terminate: () => Promise<unknown>;
  setParameters: (p: Record<string, string>) => Promise<unknown>;
};

const require = createRequire(import.meta.url);
let workerPromise: Promise<Worker> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function langPath(): string {
  try {
    const pkgDir = path.dirname(require.resolve("@tesseract.js-data/eng/package.json"));
    return path.join(pkgDir, "4.0.0_best_int");
  } catch {
    throw new RemakeError("ocr_data_missing", "The English OCR data package is missing.", "Reinstall Remake: `npx remake-agents@latest setup`.");
  }
}

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const T = (await import("tesseract.js")) as any;
      const createWorker = T.createWorker ?? T.default?.createWorker;
      const w = (await createWorker("eng", 1, {
        langPath: langPath(),
        cachePath: ensureDir(path.join(remakeHome(), "cache", "ocr")),
        gzip: true,
        logger: () => {},
        errorHandler: () => {},
      })) as Worker;
      await w.setParameters({ tessedit_pageseg_mode: "11", preserve_interword_spaces: "1", user_defined_dpi: "144" });
      return w;
    })();
  }
  return workerPromise;
}

export async function shutdownOcr(): Promise<void> {
  if (workerPromise) {
    const w = await workerPromise.catch(() => null);
    workerPromise = null;
    await w?.terminate().catch(() => {});
  }
}

/**
 * OCR an image. Light-on-dark screens are inverted first and small images are
 * upscaled, which makes Tesseract far more reliable on UI screenshots.
 */
export async function ocrImage(input: string | Buffer, opts: { minConfidence?: number } = {}): Promise<OcrLine[]> {
  const meta = await sharp(input).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) return [];
  const scale = W < 900 ? Math.min(3, 1200 / W) : 1;
  const stats = await sharp(input).grayscale().stats();
  const dark = (stats.channels[0]?.mean ?? 255) < 110;
  let img = sharp(input).removeAlpha().grayscale();
  if (scale !== 1) img = img.resize({ width: Math.round(W * scale), kernel: "lanczos3" });
  if (dark) img = img.negate({ alpha: false });
  const buf = await img.png().toBuffer();

  const run = async () => {
    const worker = await getWorker();
    const res = await worker.recognize(buf, {}, { blocks: true, text: false });
    return res.data;
  };
  // Tesseract workers are single-threaded: serialise calls.
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  const data = await p;

  const minConf = opts.minConfidence ?? 55;
  const lines: OcrLine[] = [];
  const toBox = (b: { x0: number; y0: number; x1: number; y1: number }) => ({
    x: Math.round(b.x0 / scale),
    y: Math.round(b.y0 / scale),
    w: Math.round((b.x1 - b.x0) / scale),
    h: Math.round((b.y1 - b.y0) / scale),
  });
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const words = (line.words ?? [])
          .filter((w: any) => w.confidence >= minConf - 10 && /[\p{L}\p{N}]/u.test(w.text))
          .map((w: any) => ({ text: String(w.text), box: toBox(w.bbox), confidence: Math.round(w.confidence) }));
        if (!words.length) continue;
        const text = words.map((w: { text: string }) => w.text).join(" ").trim();
        const conf = words.reduce((a: number, w: { confidence: number }) => a + w.confidence, 0) / words.length;
        if (conf < minConf || text.length === 0) continue;
        // Single stray characters are usually icons misread as letters.
        if (text.length === 1 && conf < 85) continue;
        const x0 = Math.min(...words.map((w: any) => w.box.x));
        const y0 = Math.min(...words.map((w: any) => w.box.y));
        const x1 = Math.max(...words.map((w: any) => w.box.x + w.box.w));
        const y1 = Math.max(...words.map((w: any) => w.box.y + w.box.h));
        lines.push({ text, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, confidence: Math.round(conf), words });
      }
    }
  }
  lines.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  return mergeLines(lines);
}

/** PSM 11 splits lines into fragments; merge fragments on the same baseline that are close together. */
function mergeLines(lines: OcrLine[]): OcrLine[] {
  const out: OcrLine[] = [];
  for (const l of lines) {
    const prev = out.find(
      (o) =>
        Math.abs(o.box.y + o.box.h / 2 - (l.box.y + l.box.h / 2)) < Math.min(o.box.h, l.box.h) * 0.5 &&
        Math.abs(o.box.h - l.box.h) < Math.max(o.box.h, l.box.h) * 0.45 &&
        l.box.x - (o.box.x + o.box.w) < Math.max(o.box.h, l.box.h) * 1.2 &&
        l.box.x >= o.box.x,
    );
    if (prev) {
      const x1 = Math.max(prev.box.x + prev.box.w, l.box.x + l.box.w);
      const y0 = Math.min(prev.box.y, l.box.y);
      const y1 = Math.max(prev.box.y + prev.box.h, l.box.y + l.box.h);
      prev.text = `${prev.text} ${l.text}`;
      prev.box = { x: prev.box.x, y: y0, w: x1 - prev.box.x, h: y1 - y0 };
      prev.confidence = Math.round((prev.confidence + l.confidence) / 2);
      prev.words = [...(prev.words ?? []), ...(l.words ?? [])];
    } else out.push({ ...l, box: { ...l.box } });
  }
  return out;
}

export function normaliseText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Token-multiset F1 between two texts (1 = same words). */
export function textSimilarity(a: string, b: string): number {
  const ta = normaliseText(a).split(" ").filter(Boolean);
  const tb = normaliseText(b).split(" ").filter(Boolean);
  if (!ta.length && !tb.length) return 1;
  if (!ta.length || !tb.length) return 0;
  const counts = new Map<string, number>();
  for (const t of ta) counts.set(t, (counts.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of tb) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      common++;
      counts.set(t, c - 1);
    }
  }
  const p = common / tb.length;
  const r = common / ta.length;
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

/** Normalised Levenshtein similarity for short strings. */
export function stringSimilarity(a: string, b: string): number {
  const x = normaliseText(a);
  const y = normaliseText(b);
  if (!x && !y) return 1;
  const m = x.length;
  const n = y.length;
  const prev = new Array(n + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= m; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - prev[n] / Math.max(m, n, 1);
}
