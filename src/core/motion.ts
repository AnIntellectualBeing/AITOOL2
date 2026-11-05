import { diffGray, type Box, type DiffStats } from "./image.js";
import type { GraySamples } from "./ffmpeg.js";

export interface StableSegment {
  start: number;
  end: number;
  /** Index (into samples) of the representative, fully settled frame. */
  repIndex: number;
  startIndex: number;
  endIndex: number;
}

export interface MotionSegment {
  start: number;
  end: number;
  startIndex: number;
  endIndex: number;
  /** Union of changed pixels during the motion, in sample coordinates. */
  bbox: Box | null;
  /** Peak per-frame changed fraction. */
  peak: number;
  /** Max ffmpeg scdet score inside the run (0-100); high = hard cut. */
  sceneScore: number;
}

export interface Timeline {
  diffs: DiffStats[];
  changeThreshold: number;
  stable: StableSegment[];
  motions: MotionSegment[];
}

function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * Split a sampled video into "held" UI states and the motion between them,
 * using the frame-difference curve (fraction of changed pixels per frame).
 */
export function segmentTimeline(s: GraySamples, opts: { minHold?: number; mergeGap?: number } = {}): Timeline {
  const n = s.frames.length;
  const diffs: DiffStats[] = [{ changed: 0, mafd: 0, bbox: null }];
  for (let i = 1; i < n; i++) diffs.push(diffGray(s.frames[i - 1], s.frames[i], s.width, s.height));
  const sortedChanged = diffs.map((d) => d.changed).sort((a, b) => a - b);
  const noise = sortedChanged[Math.floor(sortedChanged.length * 0.5)] ?? 0;
  const changeThreshold = Math.max(0.0008, noise * 3);
  const moving = diffs.map((d) => d.changed > changeThreshold);

  const minHold = opts.minHold ?? 0.25;
  const mergeGap = opts.mergeGap ?? 0.2;
  const dt = 1 / s.fps;

  // Raw motion runs over diff indices i (change between frame i-1 and i).
  const runs: Array<[number, number]> = [];
  for (let i = 1; i < n; i++) {
    if (!moving[i]) continue;
    const last = runs[runs.length - 1];
    if (last && (i - last[1] - 1) * dt < mergeGap) last[1] = i;
    else runs.push([i, i]);
  }

  const motions: MotionSegment[] = runs.map(([a, b]) => {
    let bbox: Box | null = null;
    let peak = 0;
    let scene = 0;
    for (let i = a; i <= b; i++) {
      bbox = unionBox(bbox, diffs[i].bbox);
      peak = Math.max(peak, diffs[i].changed);
      scene = Math.max(scene, s.sceneScores[i] ?? 0);
    }
    return { start: s.times[a - 1], end: s.times[b], startIndex: a - 1, endIndex: b, bbox, peak, sceneScore: scene };
  });

  // Stable segments are the gaps between motion runs.
  const stable: StableSegment[] = [];
  let cursor = 0;
  const pushStable = (si: number, ei: number) => {
    if (ei < si) return;
    const dur = s.times[ei] - s.times[si];
    if (dur + dt < minHold && !(si === 0 && ei === n - 1)) return;
    const rep = Math.min(ei, Math.max(si, Math.round(si + (ei - si) * 0.6)));
    stable.push({ start: s.times[si], end: s.times[ei] + dt, repIndex: rep, startIndex: si, endIndex: ei });
  };
  for (const m of motions) {
    pushStable(cursor, m.startIndex);
    cursor = m.endIndex;
  }
  pushStable(cursor, n - 1);
  if (stable.length === 0 && n > 0) stable.push({ start: 0, end: s.times[n - 1] + dt, repIndex: Math.floor(n / 2), startIndex: 0, endIndex: n - 1 });
  return { diffs, changeThreshold, stable, motions };
}

// ------------------------------------------------------------ easing

export interface EasingFit {
  name: string;
  cubicBezier: [number, number, number, number] | null;
  css: string;
  rmse: number;
}

const EASINGS: Array<{ name: string; bez: [number, number, number, number] }> = [
  { name: "linear", bez: [0, 0, 1, 1] },
  { name: "ease", bez: [0.25, 0.1, 0.25, 1] },
  { name: "ease-in", bez: [0.42, 0, 1, 1] },
  { name: "ease-out", bez: [0, 0, 0.58, 1] },
  { name: "ease-in-out", bez: [0.42, 0, 0.58, 1] },
  { name: "ease-out-quint", bez: [0.22, 1, 0.36, 1] },
  { name: "ease-in-out-quint", bez: [0.83, 0, 0.17, 1] },
];

export function cubicBezierAt(t: number, [x1, y1, x2, y2]: [number, number, number, number]): number {
  // Solve x(u) = t for u with Newton + bisection, return y(u).
  const bx = (u: number) => 3 * x1 * u * (1 - u) ** 2 + 3 * x2 * u * u * (1 - u) + u ** 3;
  const by = (u: number) => 3 * y1 * u * (1 - u) ** 2 + 3 * y2 * u * u * (1 - u) + u ** 3;
  let lo = 0;
  let hi = 1;
  let u = t;
  for (let i = 0; i < 30; i++) {
    const x = bx(u);
    if (Math.abs(x - t) < 1e-5) break;
    if (x < t) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return by(u);
}

/** Pick the closest standard easing curve for normalised (t, progress) samples. */
export function fitEasing(samples: Array<{ t: number; p: number }>): EasingFit {
  const pts = samples.filter((s) => s.t > 0.001 && s.t < 0.999);
  const overshoot = samples.some((s) => s.p > 1.06);
  if (overshoot) {
    return { name: "spring", cubicBezier: [0.34, 1.56, 0.64, 1], css: "cubic-bezier(0.34, 1.56, 0.64, 1)", rmse: 0 };
  }
  if (pts.length < 2) {
    return { name: "ease-out", cubicBezier: [0, 0, 0.58, 1], css: "ease-out", rmse: NaN };
  }
  let best: EasingFit | null = null;
  for (const e of EASINGS) {
    let se = 0;
    for (const s of pts) se += (cubicBezierAt(s.t, e.bez) - Math.max(0, Math.min(1, s.p))) ** 2;
    const rmse = Math.sqrt(se / pts.length);
    if (!best || rmse < best.rmse - 1e-9) {
      const css = e.name === "linear" || e.name.startsWith("ease") && !e.name.includes("quint") ? e.name : `cubic-bezier(${e.bez.join(", ")})`;
      best = { name: e.name, cubicBezier: e.bez, css, rmse };
    }
  }
  return best!;
}

// ------------------------------------------------------------ motion classification

export type AnimationKind =
  | "fade"
  | "fade-up"
  | "fade-down"
  | "fade-left"
  | "fade-right"
  | "slide-left"
  | "slide-right"
  | "slide-up"
  | "slide-down"
  | "scroll"
  | "cut"
  | "other";

interface Sampler {
  w: number;
  h: number;
  R: Box;
  /** Sample positions inside R (every 2nd pixel). */
  pts: Int32Array;
}

function sampler(w: number, h: number, R: Box, frames?: Uint8Array[]): Sampler {
  // Only pixels that actually change carry information (flat UI backgrounds match any shift).
  const list: number[] = [];
  const A = frames?.[0];
  const B = frames?.[frames.length - 1];
  const M = frames?.[Math.floor((frames.length - 1) / 2)];
  for (let y = R.y; y < R.y + R.h; y++) {
    for (let x = R.x; x < R.x + R.w; x++) {
      const p = y * w + x;
      if (A && B && M && Math.abs(A[p] - B[p]) <= 14 && Math.abs(M[p] - B[p]) <= 14 && Math.abs(M[p] - A[p]) <= 14) continue;
      list.push(p);
    }
  }
  // Subsample to keep things fast.
  const maxPts = 12_000;
  const stride = Math.max(1, Math.ceil(list.length / maxPts));
  const pts = stride === 1 ? list : list.filter((_, i) => i % stride === 0);
  return { w, h, R, pts: Int32Array.from(pts.length ? pts : [R.y * w + R.x]) };
}

/** Mean of the lowest `keep` fraction of absolute errors (robust to partly-matching regions). */
function trimmedMean(errs: Uint16Array, n: number, keep = 0.9): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[Math.min(255, errs[i])]++;
  const target = Math.max(1, Math.floor(n * keep));
  let seen = 0;
  let sum = 0;
  for (let v = 0; v < 256 && seen < target; v++) {
    const take = Math.min(hist[v], target - seen);
    seen += take;
    sum += take * v;
  }
  return sum / Math.max(1, seen);
}

/**
 * Error of f(p) ≈ alpha*A(p) + (1-alpha)*S(p + d) where S is shifted along `axis`.
 * Returns the robust residual and the least-squares alpha (when `fitAlpha`).
 */
function modelError(
  f: Uint8Array,
  S: Uint8Array,
  A: Uint8Array | null,
  sm: Sampler,
  axis: "x" | "y",
  d: number,
  buf: Uint16Array,
  other?: Uint8Array,
): { err: number; alpha: number; coverage: number } {
  const { w, h, pts } = sm;
  let n = 0;
  let num = 0;
  let den = 0;
  // First pass: alpha (if blending with A).
  if (A) {
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const x = p % w;
      const y = (p - x) / w;
      const sx = axis === "x" ? x + d : x;
      const sy = axis === "y" ? y + d : y;
      if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
      const sv = S[sy * w + sx];
      const dd = A[p] - sv;
      num += (f[p] - sv) * dd;
      den += dd * dd;
    }
  }
  const alpha = A && den > 0 ? Math.max(0, Math.min(1, num / den)) : 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const x = p % w;
    const y = (p - x) / w;
    const sx = axis === "x" ? x + d : x;
    const sy = axis === "y" ? y + d : y;
    if (sx < 0 || sx >= w || sy < 0 || sy >= h) {
      // Cover/reveal: where the moving layer doesn't reach, the static other frame shows.
      if (other) buf[n++] = Math.abs(f[p] - other[p]);
      continue;
    }
    const pred = A ? alpha * A[p] + (1 - alpha) * S[sy * w + sx] : S[sy * w + sx];
    buf[n++] = Math.abs(f[p] - pred);
  }
  return { err: n > pts.length * 0.3 ? trimmedMean(buf, n) : Infinity, alpha, coverage: n / pts.length };
}

function bestShift(
  f: Uint8Array,
  S: Uint8Array,
  A: Uint8Array | null,
  sm: Sampler,
  axis: "x" | "y",
  maxShift: number,
  buf: Uint16Array,
  other?: Uint8Array,
): { d: number; err: number; alpha: number } {
  // With a composite "other" frame, d = 0 is a degenerate (everything-is-static) fit: skip it.
  let best = other ? { d: 0, err: Infinity, alpha: 0, coverage: 0 } : { d: 0, ...modelError(f, S, A, sm, axis, 0, buf) };
  const step = maxShift > 30 ? 3 : 1;
  for (let d = -maxShift; d <= maxShift; d += step) {
    if (d === 0) continue;
    const e = modelError(f, S, A, sm, axis, d, buf, other);
    if (e.err < best.err) best = { d, ...e };
  }
  if (step > 1) {
    const c = best.d;
    for (let d = c - 2; d <= c + 2; d++) {
      if (d === c || d === 0 || Math.abs(d) > maxShift) continue;
      const e = modelError(f, S, A, sm, axis, d, buf, other);
      if (e.err < best.err) best = { d, ...e };
    }
  }
  return best;
}

/** Best shift d so that a(p + d) ≈ b(p) along an axis (whole-frame search). */
export function estimateShift(a: Uint8Array, b: Uint8Array, w: number, h: number, axis: "x" | "y", region?: Box) {
  const sm = sampler(w, h, region ?? { x: 0, y: 0, w, h });
  const buf = new Uint16Array(sm.pts.length);
  const base = modelError(b, a, null, sm, axis, 0, buf).err;
  const best = bestShift(b, a, null, sm, axis, Math.floor((axis === "y" ? h : w) * 0.9), buf);
  return { shift: best.d, error: best.err, baseError: base };
}

export interface AnimationAnalysis {
  kind: AnimationKind;
  detail?: string;
  progress: Array<{ t: number; p: number }>;
  easing: EasingFit;
  scrollPx?: number;
}

/**
 * Classify a motion between frame A (before) and B (after) using the
 * intermediate frames, and measure its progress curve for easing.
 * Models tried per frame: cross-fade, new content sliding in, old content
 * sliding out, and fade combined with a small shift (the common web "fade up").
 */
export function analyseAnimation(frames: Uint8Array[], w: number, h: number, region: Box | null): AnimationAnalysis {
  const R0 = region && region.w > 4 && region.h > 4 ? region : { x: 0, y: 0, w, h };
  const full = analyseRegion(frames, w, h, R0);
  if (full.kind !== "fade" && full.kind !== "other") return full;
  // A bottom sheet over a fading scrim, a drawer over a dimmed page…: look at the halves.
  const halves: Box[] = [
    { x: R0.x, y: R0.y + Math.floor(R0.h / 2), w: R0.w, h: Math.ceil(R0.h / 2) },
    { x: R0.x, y: R0.y, w: R0.w, h: Math.floor(R0.h / 2) },
    { x: R0.x, y: R0.y, w: Math.floor(R0.w / 2), h: R0.h },
    { x: R0.x + Math.floor(R0.w / 2), y: R0.y, w: Math.ceil(R0.w / 2), h: R0.h },
  ];
  const names = ["bottom half", "top half", "left half", "right half"];
  for (const [k, hb] of halves.entries()) {
    if (hb.w < 8 || hb.h < 8) continue;
    const a = analyseRegion(frames, w, h, hb, true);
    if (a.kind !== "fade" && a.kind !== "other" && a.err < a.fadeErr * 0.5) {
      return { ...a, detail: `${names[k]}: ${a.kind} (e.g. a sheet/drawer); rest: ${full.kind}` };
    }
  }
  return full;
}

function analyseRegion(frames: Uint8Array[], w: number, h: number, R: Box, searchWholeFrame = false): AnimationAnalysis & { err: number; fadeErr: number } {
  const A = frames[0];
  const B = frames[frames.length - 1];
  const total = frames.length - 1;
  if (total <= 1) return { kind: "cut", progress: [], easing: { name: "none", cubicBezier: null, css: "none", rmse: 0 }, err: 0, fadeErr: 0 };
  const sm = sampler(w, h, R, frames);
  const buf = new Uint16Array(sm.pts.length);

  // Scroll: B is A moved vertically, nearly pixel-perfect over the overlap.
  const sc = bestShift(B, A, null, sm, "y", Math.floor(R.h * 0.9), buf);
  const scBase = modelError(B, A, null, sm, "y", 0, buf).err;
  if (sc.d !== 0 && sc.err < 3 && sc.err < scBase * 0.25) {
    const idx = Array.from({ length: total - 1 }, (_, i) => i + 1);
    const progress = idx.map((i) => ({ t: i / total, p: bestShift(frames[i], A, null, sm, "y", Math.abs(sc.d) + 4, buf).d / sc.d }));
    return { kind: "scroll", progress, easing: fitEasing(progress), scrollPx: sc.d, err: sc.err, fadeErr: Infinity };
  }

  // Up to 8 evenly spaced intermediate frames.
  const mids: number[] = [];
  const count = Math.min(8, total - 1);
  for (let k = 1; k <= count; k++) mids.push(Math.round((k * total) / (count + 1)));
  const uniqMids = [...new Set(mids)].filter((i) => i > 0 && i < total);

  type Model = { kind: AnimationKind; err: number; prog: Array<{ t: number; p: number }> };
  const models: Model[] = [];
  // Synthetic "empty" frame filled with the background value of B (for content fading in from nothing).
  const hist = new Uint32Array(256);
  for (let y = R.y; y < R.y + R.h; y++) for (let x = R.x; x < R.x + R.w; x++) hist[B[y * w + x]]++;
  let bgVal = 0;
  for (let v = 1; v < 256; v++) if (hist[v] > hist[bgVal]) bgVal = v;
  const empty = new Uint8Array(A.length).fill(bgVal);
  // Cross-fade
  {
    let err = 0;
    const prog = uniqMids.map((i) => {
      const e = modelError(frames[i], B, A, sm, "x", 0, buf);
      err += e.err;
      return { t: i / total, p: 1 - e.alpha };
    });
    models.push({ kind: "fade", err: err / uniqMids.length, prog });
  }
  // Fade in from empty background (old content removed instantly, new content fades in)
  {
    let err = 0;
    const prog = uniqMids.map((i) => {
      const e = modelError(frames[i], B, empty, sm, "x", 0, buf);
      err += e.err;
      return { t: i / total, p: 1 - e.alpha };
    });
    if (err / uniqMids.length < models[0].err) models[0] = { kind: "fade", err: err / uniqMids.length, prog };
  }
  for (const axis of ["x", "y"] as const) {
    const len = axis === "x" ? (searchWholeFrame ? w : R.w) : searchWholeFrame ? h : R.h;
    const maxShift = Math.floor(len * 0.95);
    // New content slides in: f(p) ≈ B(p + d)
    {
      let err = 0;
      const ds: number[] = [];
      for (const i of uniqMids) {
        // New content covers the old (which stays put underneath).
        const r = bestShift(frames[i], B, null, sm, axis, maxShift, buf, A);
        err += r.err;
        ds.push(r.d);
      }
      const sum = ds.reduce((a, b) => a + b, 0);
      // f(p) = B(p + d) with d < 0 means B is drawn further along +axis (still travelling towards -axis).
      const kind: AnimationKind = axis === "x" ? (sum < 0 ? "slide-left" : "slide-right") : sum < 0 ? "slide-up" : "slide-down";
      const abs = ds.map(Math.abs);
      let d0 = Math.max(1, ...abs);
      if (abs.length >= 2 && abs[0] > abs[1]) d0 = Math.max(d0, abs[0] + (abs[0] - abs[1]) * (uniqMids[0] / Math.max(1, uniqMids[1] - uniqMids[0])));
      d0 = Math.min(d0, len);
      models.push({ kind, err: err / uniqMids.length, prog: ds.map((d, k) => ({ t: uniqMids[k] / total, p: 1 - Math.abs(d) / d0 })) });
    }
    // Old content slides out: f(p) ≈ A(p + d)
    {
      let err = 0;
      const ds: number[] = [];
      for (const i of uniqMids) {
        // Old content slides away, revealing the new screen underneath.
        const r = bestShift(frames[i], A, null, sm, axis, maxShift, buf, B);
        err += r.err;
        ds.push(r.d);
      }
      const sum = ds.reduce((a, b) => a + b, 0);
      // f(p) = A(p + d) with d < 0 means A moved towards +axis.
      const kind: AnimationKind = axis === "x" ? (sum < 0 ? "slide-right" : "slide-left") : sum < 0 ? "slide-down" : "slide-up";
      const abs = ds.map(Math.abs);
      const n = abs.length;
      let dEnd = Math.max(1, ...abs);
      if (n >= 2 && abs[n - 1] > abs[n - 2]) dEnd = Math.max(dEnd, abs[n - 1] + (abs[n - 1] - abs[n - 2]) * ((total - uniqMids[n - 1]) / Math.max(1, uniqMids[n - 1] - uniqMids[n - 2])));
      dEnd = Math.min(dEnd, len);
      models.push({ kind, err: err / uniqMids.length, prog: ds.map((d, k) => ({ t: uniqMids[k] / total, p: Math.abs(d) / dEnd })) });
    }
    // Fade + small shift of the new content (e.g. opacity 0→1 with translateY(12px)→0),
    // blending either with the old frame or with an empty background.
    for (const base of [A, empty]) {
      let err = 0;
      const ds: number[] = [];
      const prog: Array<{ t: number; p: number }> = [];
      for (const i of uniqMids) {
        const r = bestShift(frames[i], B, base, sm, axis, Math.max(2, Math.floor(len * 0.12)), buf);
        err += r.err;
        ds.push(r.d);
        prog.push({ t: i / total, p: 1 - r.alpha });
      }
      const sum = ds.reduce((a, b) => a + b, 0);
      const kind: AnimationKind = axis === "x" ? (sum < 0 ? "fade-left" : "fade-right") : sum < 0 ? "fade-up" : "fade-down";
      models.push({ kind, err: err / uniqMids.length, prog });
    }
  }
  const fade = models[0];
  if (process.env.REMAKE_DEBUG_ANIM) console.error("[anim]", JSON.stringify(R), models.map((m) => `${m.kind}:${m.err.toFixed(2)}`).join(" "));
  let best = models.reduce((a, b) => (b.err < a.err ? b : a));
  // Prefer the simpler cross-fade unless the shifted variant is clearly better.
  if (best.kind.startsWith("fade-") && best.err > fade.err * 0.85) best = fade;
  const meaningful = best.err < 28;
  return { kind: meaningful ? best.kind : "other", progress: best.prog, easing: fitEasing(best.prog), err: best.err, fadeErr: fade.err };
}

/**
 * Find the frames where the main motion starts/ends inside a dense sample.
 * Small changes (a touch dot fading, a cursor) are ignored relative to the peak.
 */
export function motionBounds(frames: Uint8Array[], w: number, h: number, threshold: number, region?: Box): { first: number; last: number } {
  const ch: number[] = [0];
  for (let i = 1; i < frames.length; i++) ch.push(diffGray(frames[i - 1], frames[i], w, h, 10, region).changed);
  const peak = Math.max(...ch);
  const th = Math.max(region ? 0.004 : threshold, peak * 0.03);
  let first = -1;
  let last = -1;
  for (let i = 1; i < frames.length; i++) {
    if (ch[i] > th) {
      if (first < 0) first = i - 1;
      last = i;
    }
  }
  return { first, last };
}
