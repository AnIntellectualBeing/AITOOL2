import { writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { RemakeError } from "../core/errors.js";
import { run } from "../core/exec.js";
import { findTools, h264Args, probe, type VideoInfo } from "../core/ffmpeg.js";
import { escapeXml } from "../core/image.js";
import { ensureDir, workRoot } from "../core/paths.js";

export type Layout = "16:9" | "9:16";

export interface SideBySideOptions {
  original: string;
  build: string;
  layouts?: Layout[];
  /** "Made with Remake" label. On by default; pass false to remove it. */
  watermark?: boolean;
  labels?: { original?: string; build?: string };
  /**
   * How to line the two videos up in time:
   * - "segments": stretch each build segment so marked moments line up (needs marks)
   * - "stretch": stretch the whole build to the original's length
   * - "pad": play both at natural speed; the shorter one holds its last frame
   */
  sync?: "segments" | "stretch" | "pad";
  /** Matching moments (seconds), e.g. when each screen appears, in the original and the build. */
  originalMarks?: number[];
  buildMarks?: number[];
  gif?: boolean;
  outDir?: string;
}

export interface SideBySideResult {
  videos: Array<{ layout: Layout; path: string; width: number; height: number; duration: number }>;
  gif?: string;
  watermark: boolean;
  sync: string;
  notes: string[];
}

const CANVAS: Record<Layout, { w: number; h: number }> = { "16:9": { w: 1920, h: 1080 }, "9:16": { w: 1080, h: 1920 } };
const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);

function fit(w: number, h: number, boxW: number, boxH: number) {
  const s = Math.min(boxW / w, boxH / h);
  return { w: even(w * s), h: even(h * s), scale: s };
}

/** Where the two videos go on the canvas: side by side or stacked, whichever shows them bigger. */
export function planLayout(layout: Layout, a: { w: number; h: number }, b: { w: number; h: number }) {
  const { w: W, h: H } = CANVAS[layout];
  const m = Math.round(W * 0.025);
  const labelH = Math.round(H * (layout === "16:9" ? 0.07 : 0.045));
  const footer = Math.round(H * (layout === "16:9" ? 0.06 : 0.04));
  const plans = (["row", "column"] as const).map((dir) => {
    const paneW = dir === "row" ? (W - 3 * m) / 2 : W - 2 * m;
    const paneH = dir === "row" ? H - labelH - footer - m : (H - 2 * labelH - footer - 2 * m) / 2;
    const fa = fit(a.w, a.h, paneW, paneH);
    const fb = fit(b.w, b.h, paneW, paneH);
    const panes =
      dir === "row"
        ? [
            { x: m, y: labelH, w: paneW, h: paneH },
            { x: 2 * m + paneW, y: labelH, w: paneW, h: paneH },
          ]
        : [
            { x: m, y: labelH, w: paneW, h: paneH },
            { x: m, y: 2 * labelH + paneH + m, w: paneW, h: paneH },
          ];
    const place = (f: { w: number; h: number }, p: { x: number; y: number; w: number; h: number }) => ({
      ...f,
      x: Math.round(p.x + (p.w - f.w) / 2),
      y: Math.round(p.y + (p.h - f.h) / 2),
      labelX: Math.round(p.x + p.w / 2),
      labelY: Math.round(p.y - labelH * 0.35),
    });
    let pa = place(fa, panes[0]);
    let pb = place(fb, panes[1]);
    if (dir === "row") {
      // Centre label + video as one block and keep the label right above the video.
      const maxH = Math.max(fa.h, fb.h);
      const top = Math.round((H - footer - (labelH + maxH)) / 2 + labelH);
      pa = { ...pa, y: top + Math.round((maxH - fa.h) / 2), labelY: Math.round(top - labelH * 0.4) };
      pb = { ...pb, y: top + Math.round((maxH - fb.h) / 2), labelY: Math.round(top - labelH * 0.4) };
    } else {
      pa = { ...pa, labelY: Math.round(pa.y - labelH * 0.4) };
      pb = { ...pb, labelY: Math.round(pb.y - labelH * 0.4) };
    }
    return { dir, score: Math.min(fa.scale, fb.scale), a: pa, b: pb, W, H, labelH, footer, m };
  });
  return plans[0].score >= plans[1].score ? plans[0] : plans[1];
}

async function overlayPng(file: string, plan: ReturnType<typeof planLayout>, labels: { original: string; build: string }, watermark: boolean) {
  const { W, H } = plan;
  const fs = Math.round(plan.labelH * 0.42);
  const pill = (cx: number, cy: number, text: string, accent: boolean) => {
    const tw = Math.round(text.length * fs * 0.6 + fs * 1.6);
    return `<rect x="${cx - tw / 2}" y="${cy - fs * 0.95}" width="${tw}" height="${fs * 1.6}" rx="${fs * 0.8}" fill="${accent ? "#6d5dfc" : "#2a2a33"}"/>
<text x="${cx}" y="${cy + fs * 0.12}" font-size="${fs}" font-weight="700" font-family="Helvetica, Arial, sans-serif" fill="#fff" text-anchor="middle">${escapeXml(text)}</text>`;
  };
  const wm = watermark
    ? `<text x="${W - plan.m}" y="${H - plan.footer * 0.38}" font-size="${Math.round(plan.footer * 0.36)}" font-family="Helvetica, Arial, sans-serif" fill="rgba(255,255,255,0.62)" text-anchor="end">Made with Remake</text>`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${pill(plan.a.labelX, plan.a.labelY, labels.original, false)}${pill(plan.b.labelX, plan.b.labelY, labels.build, true)}${wm}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
  return file;
}

/** ffmpeg filter that re-times the build so marked moments line up with the original. */
export function segmentFilter(input: string, out: string, o: number[], b: number[], Do: number, Db: number): { filter: string; duration: number } {
  const ob = [0, ...o, Do];
  const bb = [0, ...b, Db];
  const parts: string[] = [];
  const labels: string[] = [];
  let duration = 0;
  for (let k = 0; k < ob.length - 1; k++) {
    const bs = bb[k];
    const be = bb[k + 1];
    const target = ob[k + 1] - ob[k];
    if (be - bs < 0.04 || target < 0.04) continue;
    const f = Math.max(0.25, Math.min(4, target / (be - bs)));
    duration += (be - bs) * f;
    labels.push(`[c${k}]`);
    parts.push(`[s${k}]trim=start=${bs.toFixed(3)}:end=${be.toFixed(3)},setpts=(PTS-STARTPTS)*${f.toFixed(4)}[c${k}]`);
  }
  const splits = parts.map((p) => p.match(/^\[(s\d+)\]/)![1]);
  const filter = `${input}split=${splits.length}${splits.map((s) => `[${s}]`).join("")};${parts.join(";")};${labels.join("")}concat=n=${labels.length}:v=1:a=0${out}`;
  return { filter, duration };
}

/** Original vs remake comparison videos (16:9 and 9:16) with a small "Made with Remake" label. */
export async function makeSideBySide(opts: SideBySideOptions): Promise<SideBySideResult> {
  const { ffmpeg } = findTools();
  const [oi, bi]: VideoInfo[] = await Promise.all([probe(opts.original), probe(opts.build)]);
  const layouts = opts.layouts?.length ? opts.layouts : (["16:9", "9:16"] as Layout[]);
  const watermark = opts.watermark !== false;
  const labels = { original: opts.labels?.original ?? "Original", build: opts.labels?.build ?? "Remake" };
  const notes: string[] = [];
  let sync = opts.sync ?? (opts.originalMarks?.length && opts.buildMarks?.length ? "segments" : "pad");
  if (sync === "segments" && (!opts.originalMarks?.length || opts.originalMarks.length !== opts.buildMarks?.length)) {
    notes.push("segments sync needs originalMarks and buildMarks of the same length; fell back to pad.");
    sync = "pad";
  }
  if (Math.max(oi.duration, bi.duration) > 180) {
    throw new RemakeError("too_long", "Side-by-side videos are limited to 3 minutes.", "Trim the original recording first.");
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = ensureDir(opts.outDir ? path.resolve(opts.outDir) : path.join(workRoot(), "side-by-side", stamp));
  const result: SideBySideResult = { videos: [], watermark, sync, notes };

  for (const layout of layouts) {
    const plan = planLayout(layout, { w: oi.width, h: oi.height }, { w: bi.width, h: bi.height });
    const png = await overlayPng(path.join(outDir, `overlay-${layout.replace(":", "x")}.png`), plan, labels, watermark);
    let buildChain = "[1:v]";
    let buildDur = bi.duration;
    const pre: string[] = [];
    if (sync === "segments") {
      const seg = segmentFilter("[1:v]", "[bs]", opts.originalMarks!, opts.buildMarks!, oi.duration, bi.duration);
      pre.push(seg.filter);
      buildChain = "[bs]";
      buildDur = seg.duration;
    } else if (sync === "stretch") {
      const f = oi.duration / bi.duration;
      pre.push(`[1:v]setpts=PTS*${f.toFixed(4)}[bs]`);
      buildChain = "[bs]";
      buildDur = bi.duration * f;
    }
    const D = Math.max(oi.duration, buildDur) + 0.6;
    const filter = [
      ...pre,
      `[0:v]fps=30,scale=${plan.a.w}:${plan.a.h}:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration=${(D - oi.duration + 0.1).toFixed(2)}[va]`,
      `${buildChain}fps=30,scale=${plan.b.w}:${plan.b.h}:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration=${(D - buildDur + 0.1).toFixed(2)}[vb]`,
      `color=c=0x0d0d12:s=${plan.W}x${plan.H}:r=30:d=${D.toFixed(2)}[bg]`,
      `[bg][va]overlay=${plan.a.x}:${plan.a.y}[t1]`,
      `[t1][vb]overlay=${plan.b.x}:${plan.b.y}[t2]`,
      `[t2][2:v]overlay=0:0:format=auto,format=yuv420p[out]`,
    ].join(";");
    const out = path.join(outDir, `side-by-side-${layout.replace(":", "x")}.mp4`);
    await run(
      ffmpeg,
      ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", opts.original, "-i", opts.build, "-loop", "1", "-i", png, "-filter_complex", filter, "-map", "[out]", "-t", D.toFixed(2), "-an", ...(await h264Args(21)), out],
      { label: "ffmpeg (side-by-side)", timeoutMs: 10 * 60_000 },
    );
    result.videos.push({ layout, path: out, width: plan.W, height: plan.H, duration: Math.round(D * 100) / 100 });
  }

  if (opts.gif) {
    const src = result.videos.find((v) => v.layout === "16:9") ?? result.videos[0];
    const gif = path.join(outDir, "side-by-side.gif");
    await run(
      ffmpeg,
      ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", src.path, "-vf", `fps=12,scale=${src.layout === "16:9" ? 960 : 480}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, gif],
      { label: "ffmpeg (gif)", timeoutMs: 10 * 60_000 },
    );
    result.gif = gif;
  }
  writeFileSync(path.join(outDir, "side-by-side.json"), JSON.stringify(result, null, 2));
  return result;
}
