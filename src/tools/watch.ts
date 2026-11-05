import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeContactSheet } from "../core/contactSheet.js";
import { extractPalette, layoutBoxes, spacingFrom, typeScale, fontSizeFromBox, type Palette, type Spacing, type TypeLevel } from "../core/design.js";
import { downloadVideo, isUrl } from "../core/download.js";
import { mapLimit } from "../core/exec.js";
import { RemakeError } from "../core/errors.js";
import { extractFrame, probe, sampleGray, type GraySamples, type VideoInfo } from "../core/ffmpeg.js";
import { diffGray, estimateImageTokens, hamming, phashGray } from "../core/image.js";
import { analyseAnimation, motionBounds, segmentTimeline, type AnimationKind, type MotionSegment } from "../core/motion.js";
import { ocrImage, type OcrLine } from "../core/ocr.js";
import { ensureDir, timeTag, timestampLabel, videoWorkDir } from "../core/paths.js";
import { transcribe, type TranscriptResult } from "../core/transcribe.js";

export const ANALYSIS_VERSION = 3;

export type Budget = "low" | "normal" | "high";

export const BUDGETS = {
  low: { fps: 6, analysisPixels: 22_000, maxKeyframes: 10, thumbWidth: 360, sheets: 1, sheetCells: 12, sheetWidth: 1024, maxAnimations: 4, ocrMax: 8 },
  normal: { fps: 12, analysisPixels: 45_000, maxKeyframes: 20, thumbWidth: 480, sheets: 2, sheetCells: 12, sheetWidth: 1280, maxAnimations: 10, ocrMax: 16 },
  high: { fps: 20, analysisPixels: 90_000, maxKeyframes: 40, thumbWidth: 720, sheets: 4, sheetCells: 12, sheetWidth: 1536, maxAnimations: 20, ocrMax: 40 },
} as const;

/** Hard limits that keep token use and run time sane. */
export const LIMITS = { maxDurationSeconds: 600, maxSampledFrames: 2400 };

export interface TextLine {
  text: string;
  /** [x, y, w, h] normalised 0..1 */
  box: [number, number, number, number];
  sizePx?: number;
}

export interface StateInfo {
  id: string;
  name: string;
  keyframe: string;
  thumbnail: string;
  time: number;
  visits: Array<{ start: number; end: number }>;
  holdSeconds: number;
  phash: string;
  text: TextLine[];
}

export interface AnimationInfo {
  from: string;
  to: string;
  start: number;
  durationMs: number;
  /** Timing resolution of durationMs (one frame of the recording). */
  precisionMs: number;
  kind: AnimationKind;
  detail?: string;
  easing: string;
  cubicBezier: [number, number, number, number] | null;
  /** Region that moved, [x, y, w, h] normalised. */
  region: [number, number, number, number] | null;
  hardCut: boolean;
  /** True when the screen stays the same (toggle, press feedback, hover…). */
  inScreen: boolean;
  scrollPx?: number;
}

export interface WatchResult {
  version: number;
  video: { path: string; source?: string; duration: number; width: number; height: number; fps: number; hasAudio: boolean };
  budget: Budget;
  workDir: string;
  platform: "phone" | "tablet" | "desktop";
  cssScale: number;
  cssViewport: { width: number; height: number };
  suggestedCrop: { top: number; bottom: number };
  states: StateInfo[];
  timeline: Array<{ state: string; start: number; end: number }>;
  animations: AnimationInfo[];
  palette: Palette;
  typeScale: TypeLevel[];
  spacing: Spacing;
  contactSheets: Array<{ path: string; width: number; height: number; shows: string }>;
  transcript: TranscriptResult;
  tokenEstimate: { contactSheets: number };
  notes: string[];
}

export interface WatchOptions {
  budget?: Budget;
  outDir?: string;
  transcribe?: boolean;
  ocr?: boolean;
  force?: boolean;
  onProgress?: (message: string, fraction?: number) => void;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const median = (values: number[]) => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const normBox = (b: { x: number; y: number; w: number; h: number }, W: number, H: number): [number, number, number, number] => [
  r3(b.x / W),
  r3(b.y / H),
  r3(b.w / W),
  r3(b.h / H),
];

function clampBox(b: { x: number; y: number; w: number; h: number }, W: number, H: number) {
  const x = Math.max(0, b.x);
  const y = Math.max(0, b.y);
  return { x, y, w: Math.max(1, Math.min(W - x, b.w)), h: Math.max(1, Math.min(H - y, b.h)) };
}

export function guessPlatform(width: number, height: number): { platform: WatchResult["platform"]; cssScale: number } {
  const aspect = height / width;
  const pick = (target: number, scales: number[]) => scales.reduce((best, s) => (Math.abs(width / s - target) < Math.abs(width / best - target) ? s : best), scales[0]);
  if (aspect > 1.45) return { platform: "phone", cssScale: pick(400, [1, 2, 2.625, 3, 3.5]) };
  if (aspect > 1.05) return { platform: "tablet", cssScale: pick(820, [1, 2]) };
  return { platform: "desktop", cssScale: pick(1440, [1, 1.5, 2]) };
}

async function resolveInput(pathOrUrl: string, outDir?: string): Promise<{ file: string; source?: string }> {
  const s = pathOrUrl.trim();
  if (isUrl(s)) return { file: await downloadVideo(s, outDir), source: s };
  const file = path.resolve(s.replace(/^file:\/\//, ""));
  if (!existsSync(file)) throw new RemakeError("file_missing", `Video file not found: ${file}`, "Check the path, or pass a YouTube/Loom link.");
  return { file };
}

/** Group states: consecutive near-identical holds merge; repeats of an earlier state reuse its id. */
function clusterStates(samples: GraySamples, segs: ReturnType<typeof segmentTimeline>["stable"]) {
  const W = samples.width;
  const H = samples.height;
  const reps = segs.map((s) => samples.frames[s.repIndex]);
  const hashes = reps.map((f) => phashGray(f, W, H));
  const same = (i: number, j: number) => hamming(hashes[i], hashes[j]) <= 6 && diffGray(reps[i], reps[j], W, H, 18).changed < 0.006;
  const ids: number[] = [];
  const firstOf: number[] = [];
  for (let i = 0; i < segs.length; i++) {
    let found = -1;
    for (let k = 0; k < firstOf.length; k++) {
      if (same(i, firstOf[k])) {
        found = k;
        break;
      }
    }
    if (found < 0) {
      found = firstOf.length;
      firstOf.push(i);
    }
    ids.push(found);
  }
  return { ids, hashes };
}

export async function watchVideo(pathOrUrl: string, opts: WatchOptions = {}): Promise<WatchResult> {
  const budget: Budget = opts.budget ?? "normal";
  const B = BUDGETS[budget];
  const progress = opts.onProgress ?? (() => {});
  const { file, source } = await resolveInput(pathOrUrl, opts.outDir);
  const workDir = videoWorkDir(file, opts.outDir);
  const cachePath = path.join(workDir, `analysis-${budget}.json`);
  if (!opts.force && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as WatchResult;
      if (cached.version === ANALYSIS_VERSION && cached.states.every((s) => existsSync(s.keyframe))) return cached;
    } catch {
      /* recompute */
    }
  }
  progress("Reading video", 0.02);
  const info = await probe(file);
  const notes: string[] = [];
  if (info.duration > LIMITS.maxDurationSeconds) {
    throw new RemakeError(
      "video_too_long",
      `This video is ${Math.round(info.duration)}s long; Remake handles up to ${LIMITS.maxDurationSeconds}s.`,
      "Trim it to the flow you want rebuilt (30–90 seconds works best), e.g. `ffmpeg -ss 0 -t 90 -i in.mp4 -c copy out.mp4`.",
    );
  }
  let fps: number = B.fps;
  if (info.duration * fps > LIMITS.maxSampledFrames) {
    fps = Math.max(2, Math.floor(LIMITS.maxSampledFrames / info.duration));
    notes.push(`Long video: sampled at ${fps} fps instead of ${B.fps} to stay within limits. Short animations may be missed; trimming to 30–90 s gives better results.`);
  }
  if (info.duration > 120) notes.push("Recordings over ~2 minutes cost more tokens and usually contain repeats. Consider trimming to the key flow.");

  progress("Finding UI states and transitions", 0.08);
  const analysisWidth = Math.round(Math.sqrt((B.analysisPixels * info.width) / info.height));
  const samples = await sampleGray(info, { fps, width: analysisWidth });
  if (samples.frames.length === 0) throw new RemakeError("no_frames", "Couldn't decode any frames from this video.");
  const tl = segmentTimeline(samples);
  const { ids } = clusterStates(samples, tl.stable);

  // Unique states, with all their visits.
  const uniq = new Map<number, { segs: number[] }>();
  ids.forEach((id, i) => {
    if (!uniq.has(id)) uniq.set(id, { segs: [] });
    uniq.get(id)!.segs.push(i);
  });
  let order = [...uniq.keys()];
  const hold = (id: number) => uniq.get(id)!.segs.reduce((s, i) => s + (tl.stable[i].end - tl.stable[i].start), 0);
  if (order.length > B.maxKeyframes) {
    notes.push(`Found ${order.length} distinct UI states; kept the ${B.maxKeyframes} held longest (budget "${budget}"). Use budget "high" or get_frames for more.`);
    const keep = new Set([...order].sort((a, b) => hold(b) - hold(a)).slice(0, B.maxKeyframes));
    order = order.filter((id) => keep.has(id));
  }
  const stateName = (k: number) => `s${k + 1}`;
  const idMap = new Map(order.map((id, k) => [id, stateName(k)]));

  progress("Extracting keyframes", 0.25);
  const framesDir = ensureDir(path.join(workDir, "frames"));
  const thumbsDir = ensureDir(path.join(workDir, "thumbs"));
  const states: StateInfo[] = await mapLimit(order, 4, async (id) => {
    const segIdx = uniq.get(id)!.segs;
    // Use the longest visit as the representative.
    const best = segIdx.reduce((a, b) => (tl.stable[b].end - tl.stable[b].start > tl.stable[a].end - tl.stable[a].start ? b : a), segIdx[0]);
    const seg = tl.stable[best];
    const t = samples.times[seg.repIndex];
    const name = idMap.get(id)!;
    const keyframe = await extractFrame(file, t, path.join(framesDir, `${name}-${timeTag(t)}.png`));
    const thumbnail = await extractFrame(file, t, path.join(thumbsDir, `${name}.jpg`), Math.min(B.thumbWidth, info.width));
    const f = samples.frames[seg.repIndex];
    return {
      id: name,
      name: name,
      keyframe,
      thumbnail,
      time: r3(t),
      visits: segIdx.map((i) => ({ start: r3(tl.stable[i].start), end: r3(tl.stable[i].end) })),
      holdSeconds: r3(hold(id)),
      phash: phashGray(f, samples.width, samples.height),
      text: [],
    };
  });

  const { platform, cssScale } = guessPlatform(info.width, info.height);
  const cssViewport = { width: Math.round(info.width / cssScale), height: Math.round(info.height / cssScale) };

  // OCR
  const ocrByState = new Map<string, OcrLine[]>();
  if (opts.ocr !== false) {
    const toOcr = states.slice(0, B.ocrMax);
    if (states.length > toOcr.length) notes.push(`OCR ran on the first ${toOcr.length} states only (budget "${budget}").`);
    let done = 0;
    for (const s of toOcr) {
      progress(`Reading text (${done + 1}/${toOcr.length})`, 0.3 + 0.35 * (done / toOcr.length));
      const lines = (await ocrImage(s.keyframe)).filter((l) => !/^[0oOQ@°\s]+$/.test(l.text));
      ocrByState.set(s.id, lines);
      s.text = lines.map((l) => ({
        text: l.text,
        box: normBox(l.box, info.width, info.height),
        sizePx: Math.round(median(l.words?.map((w) => fontSizeFromBox(w.text, w.box.h)) ?? [fontSizeFromBox(l.text, l.box.h)]) / cssScale),
      }));
      done++;
    }
  }

  // Status bar (phones): a clock in the top few percent of every screen.
  let suggestedCrop = { top: 0, bottom: 0 };
  if (platform === "phone") {
    let top = 0;
    for (const lines of ocrByState.values()) {
      for (const l of lines) {
        const bottom = (l.box.y + l.box.h) / info.height;
        if (bottom < 0.075 && /\b\d{1,2}[:.]\d{2}\b/.test(l.text)) top = Math.max(top, Math.min(0.075, bottom + 0.012));
      }
    }
    if (top > 0) {
      suggestedCrop = { top: r3(top), bottom: 0.025 };
      notes.push("Detected a phone status bar (clock). Leave it out of the build; compare() crops it with suggestedCrop.");
    }
  }
  // Drop status-bar text from the per-state text and pick names.
  for (const s of states) {
    s.text = s.text.filter((l) => l.box[1] + l.box[3] > suggestedCrop.top + 0.002);
    const upper = s.text.filter((l) => l.box[1] < 0.45 && (l.text.match(/\p{L}/gu)?.length ?? 0) >= 3);
    const title = [...upper].sort((a, b) => (b.sizePx ?? 0) - (a.sizePx ?? 0) || a.box[1] - b.box[1])[0];
    s.name = title ? title.text.slice(0, 40) : s.id;
  }

  progress("Measuring colours, type and spacing", 0.68);
  const palette = await extractPalette(
    states.slice(0, 12).map((s) => ({ input: s.keyframe, ocr: ocrByState.get(s.id) })),
    { cropTop: suggestedCrop.top, cropBottom: suggestedCrop.bottom },
  );
  const allLines = [...ocrByState.values()].flat().filter((l) => l.box.y / info.height > suggestedCrop.top);
  const seen = new Set<string>();
  const uniqueLines = allLines.filter((l) => (seen.has(l.text) ? false : (seen.add(l.text), true)));
  const types = typeScale(uniqueLines, cssScale);
  const layouts = await Promise.all(states.slice(0, 12).map((s) => layoutBoxes(s.keyframe)));
  const spacing = spacingFrom(layouts, cssViewport.width);

  // Animations
  progress("Timing animations", 0.75);
  const segState = (stableIdx: number) => idMap.get(ids[stableIdx]);
  const motionInfo: Array<{ m: MotionSegment; from?: string; to?: string; inScreen: boolean }> = tl.motions.map((m) => {
    const before = tl.stable.findIndex((s) => s.endIndex === m.startIndex);
    const after = tl.stable.findIndex((s) => s.startIndex === m.endIndex);
    const from = before >= 0 ? segState(before) : undefined;
    const to = after >= 0 ? segState(after) : undefined;
    return { m, from, to, inScreen: !!from && from === to };
  });
  // A small blob that travels (a mouse cursor) is not an animation of the app.
  const isPointerOnly = (m: MotionSegment) => {
    if (!m.bbox) return true;
    let maxFrameArea = 0;
    for (let i = m.startIndex + 1; i <= m.endIndex; i++) {
      const b = tl.diffs[i].bbox;
      if (b) maxFrameArea = Math.max(maxFrameArea, b.w * b.h);
    }
    const small = maxFrameArea < samples.width * samples.height * 0.004;
    return small && m.bbox.w * m.bbox.h > maxFrameArea * 3;
  };
  const ranked = motionInfo
    .filter((x) => !(x.inScreen && isPointerOnly(x.m)))
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => Number(a.inScreen) - Number(b.inScreen) || b.m.peak - a.m.peak)
    .slice(0, B.maxAnimations)
    .sort((a, b) => a.m.start - b.m.start);
  const denseFps = Math.min(60, Math.max(fps, Math.round(info.fps)));
  const animations: AnimationInfo[] = [];
  for (const x of ranked) {
    const t0 = Math.max(0, x.m.start - 1 / fps);
    const dur = Math.min(4, x.m.end - x.m.start + 2 / fps);
    const denseWidth = Math.round(Math.sqrt((24_000 * info.width) / info.height));
    const dense = await sampleGray(info, { fps: denseFps, width: denseWidth, start: t0, duration: dur });
    if (dense.frames.length < 2) continue;
    const sx = dense.width / samples.width;
    const region = x.m.bbox
      ? clampBox({ x: Math.floor(x.m.bbox.x * sx) - 1, y: Math.floor(x.m.bbox.y * sx) - 1, w: Math.ceil(x.m.bbox.w * sx) + 2, h: Math.ceil(x.m.bbox.h * sx) + 2 }, dense.width, dense.height)
      : null;
    const { first, last } = motionBounds(dense.frames, dense.width, dense.height, tl.changeThreshold, x.inScreen && region ? region : undefined);
    if (first < 0) continue;
    const seq = dense.frames.slice(first, last + 1);
    const an = analyseAnimation(seq, dense.width, dense.height, region);
    const durationMs = Math.round(((last - first) / denseFps) * 1000);
    const hardCut = x.m.sceneScore > 40 && durationMs <= Math.round(2000 / denseFps);
    animations.push({
      from: x.from ?? "?",
      to: x.to ?? "?",
      start: r3(dense.times[first]),
      durationMs,
      precisionMs: Math.round(1000 / denseFps),
      kind: hardCut ? "cut" : an.kind,
      ...(an.detail && !hardCut ? { detail: an.detail } : {}),
      easing: hardCut ? "none" : an.easing.css,
      cubicBezier: hardCut ? null : an.easing.cubicBezier,
      region: x.m.bbox ? normBox(x.m.bbox, samples.width, samples.height) : null,
      hardCut,
      inScreen: x.inScreen,
      ...(an.scrollPx ? { scrollPx: Math.round((an.scrollPx / dense.height) * cssViewport.height) } : {}),
    });
  }

  // Timeline of visits
  const timeline: WatchResult["timeline"] = [];
  tl.stable.forEach((s, i) => {
    const st = segState(i);
    if (!st) return;
    const last = timeline[timeline.length - 1];
    if (last && last.state === st) last.end = r3(s.end);
    else timeline.push({ state: st, start: r3(s.start), end: r3(s.end) });
  });

  // Contact sheets
  progress("Making contact sheets", 0.88);
  const sheetsDir = ensureDir(path.join(workDir, "sheets"));
  const aspect = info.height / info.width;
  const contactSheets: WatchResult["contactSheets"] = [];
  for (let k = 0; k < Math.min(B.sheets, Math.ceil(states.length / B.sheetCells)); k++) {
    const chunk = states.slice(k * B.sheetCells, (k + 1) * B.sheetCells);
    const sheet = await makeContactSheet(
      chunk.map((s) => ({ path: s.thumbnail, label: `${s.id} · ${timestampLabel(s.time)}` })),
      path.join(sheetsDir, `screens-${k + 1}.jpg`),
      { maxWidth: B.sheetWidth, aspect },
    );
    contactSheets.push({ ...sheet, shows: `UI states ${chunk[0].id}–${chunk[chunk.length - 1].id}` });
  }
  if (contactSheets.length < B.sheets && animations.some((a) => !a.hardCut)) {
    // A second sheet showing transitions mid-way (start / middle / end).
    const anims = animations.filter((a) => !a.hardCut && !a.inScreen).slice(0, Math.floor(B.sheetCells / 3));
    if (anims.length) {
      const cells: Array<{ path: string; label: string }> = [];
      for (const [ai, a] of anims.entries()) {
        for (const [fi, f] of [0.0, 0.5, 1.0].entries()) {
          const t = a.start + (a.durationMs / 1000) * f;
          const p = await extractFrame(file, t, path.join(sheetsDir, "anim", `a${ai + 1}-${fi}.jpg`), Math.min(B.thumbWidth, info.width));
          cells.push({ path: p, label: `${a.from}→${a.to} ${Math.round(f * 100)}% · ${a.kind}` });
        }
      }
      const sheet = await makeContactSheet(cells, path.join(sheetsDir, "transitions.jpg"), { maxWidth: B.sheetWidth, aspect, columns: aspect > 1.2 ? 6 : 3 });
      contactSheets.push({ ...sheet, shows: "transitions (start / middle / end)" });
    }
  }

  let transcript: TranscriptResult = { status: "skipped", segments: [] };
  if (opts.transcribe !== false) {
    progress("Transcribing narration", 0.94);
    transcript = await transcribe(info, workDir);
    if (transcript.note) notes.push(transcript.note);
  }

  const result: WatchResult = {
    version: ANALYSIS_VERSION,
    video: { path: file, source, duration: r3(info.duration), width: info.width, height: info.height, fps: Math.round(info.fps * 100) / 100, hasAudio: info.hasAudio },
    budget,
    workDir,
    platform,
    cssScale,
    cssViewport,
    suggestedCrop,
    states,
    timeline,
    animations,
    palette,
    typeScale: types,
    spacing,
    contactSheets,
    transcript,
    tokenEstimate: { contactSheets: contactSheets.reduce((s, c) => s + estimateImageTokens(c.width, c.height), 0) },
    notes,
  };
  writeFileSync(cachePath, JSON.stringify(result, null, 2));
  progress("Done", 1);
  return result;
}

/** Exact frames on demand (full resolution unless `width` is given). */
export async function getFrames(pathOrUrl: string, timestamps: number[], opts: { outDir?: string; width?: number } = {}) {
  const { file } = await resolveInput(pathOrUrl, opts.outDir);
  const info: VideoInfo = await probe(file);
  if (timestamps.length > 24) throw new RemakeError("too_many_frames", `Asked for ${timestamps.length} frames; the limit is 24 per call.`, "Ask for fewer timestamps, or use watch_video's contact sheets for an overview.");
  const dir = ensureDir(path.join(videoWorkDir(file, opts.outDir), "requested"));
  const out = await mapLimit(timestamps, 4, async (t) => {
    if (t < 0 || t > info.duration + 0.05) throw new RemakeError("bad_timestamp", `Timestamp ${t}s is outside the video (0–${info.duration.toFixed(2)}s).`);
    const p = await extractFrame(file, Math.min(t, Math.max(0, info.duration - 0.04)), path.join(dir, `${timeTag(t)}${opts.width ? `-w${opts.width}` : ""}.png`), opts.width);
    return { time: t, path: p };
  });
  return { video: file, width: opts.width ?? info.width, frames: out };
}
