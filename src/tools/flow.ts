import { writeFileSync } from "node:fs";
import path from "node:path";
import { probe, sampleGray, type VideoInfo } from "../core/ffmpeg.js";
import { components, changeMask, diffGray, loadRaw, toGray, type Box } from "../core/image.js";
import { layoutBoxes } from "../core/design.js";
import { watchVideo, type Budget, type StateInfo, type WatchResult } from "./watch.js";
import type { Step } from "./record.js";

export type Evidence = "cursor" | "touch-indicator" | "press-feedback" | "transition-origin" | "scroll" | "none";

export interface Trigger {
  type: "tap" | "click" | "scroll" | "unknown";
  /** Normalised 0..1 position in the video frame. */
  x?: number;
  y?: number;
  /** Same position in CSS pixels of the app viewport. */
  cssX?: number;
  cssY?: number;
  /** Visible text at (or nearest to) the point, from OCR. */
  targetText?: string;
  /** Box of the UI element under the point, normalised [x, y, w, h]. */
  targetBox?: [number, number, number, number];
  scrollPx?: number;
  evidence: Evidence;
  confidence: number;
}

export interface FlowEdge {
  from: string;
  to: string;
  kind: "navigation" | "overlay" | "state" | "back" | "scroll";
  occurrences: Array<{ time: number; trigger: Trigger }>;
  trigger: Trigger;
  animation?: { kind: string; durationMs: number; easing: string; detail?: string };
}

export interface FlowResult {
  video: string;
  platform: WatchResult["platform"];
  cssViewport: WatchResult["cssViewport"];
  nodes: Array<{ id: string; name: string; keyframe: string; thumbnail: string; visits: number; firstSeen: number }>;
  edges: FlowEdge[];
  path: string[];
  mermaid: string;
  replaySteps: Step[];
  notes: string[];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

interface Sampled {
  w: number;
  h: number;
  frames: Uint8Array[];
  times: number[];
}

/** Locate what the user touched/clicked just before a transition. */
export function detectTrigger(s: Sampled, transitionGuess: number, platform: WatchResult["platform"]): Omit<Trigger, "type"> {
  const { w, h, frames, times } = s;
  const area = w * h;
  const ch = frames.map((f, k) => (k === 0 ? { changed: 0, mafd: 0, bbox: null as Box | null } : diffGray(frames[k - 1], f, w, h, 12)));
  const peak = Math.max(...ch.map((c) => c.changed));
  const fps = times.length > 1 ? 1 / (times[1] - times[0]) : 30;
  // Start of the big change: first frame above a fraction of the peak, near the expected time.
  let Tb = ch.findIndex((c, k) => k > 0 && c.changed > Math.max(0.01, peak * 0.25) && times[k] >= transitionGuess - 0.4);
  if (Tb < 0) Tb = ch.findIndex((c) => c.changed > Math.max(0.01, peak * 0.25));
  if (Tb < 0) return { evidence: "none", confidence: 0 };
  const tiny = 0.00004;
  // Walk back to the start of the contiguous motion run.
  let Ts = Tb;
  while (Ts - 1 >= 1 && ch[Ts - 1].changed > tiny) Ts--;
  const edge = 2;
  const notEdge = (c: Box) => c.x > edge && c.y > edge && c.x + c.w < w - edge && c.y + c.h < h - edge;
  const compsAt = (k: number, minPx = 3) =>
    components(changeMask(frames[k - 1], frames[k], 12), w, h, minPx).filter((c) => notEdge(c) && c.w * c.h < area * 0.06);
  const center = (b: Box) => ({ x: (b.x + b.w / 2) / w, y: (b.y + b.h / 2) / h });
  const isRound = (b: Box) => {
    const a = b.w / Math.max(1, b.h);
    return a > 0.6 && a < 1.6 && b.w < w * 0.25 && b.w * b.h > area * 0.0006;
  };

  if (platform !== "desktop") {
    // Touch dot / pressed state: a compact blob appearing at the start of the run (or just before it).
    for (let k = Math.max(1, Ts - Math.round(0.5 * fps)); k <= Math.min(Tb, Ts + 2); k++) {
      const round = compsAt(k, 6).filter(isRound).sort((a, b) => b.pixels - a.pixels)[0];
      if (round) {
        const p = center(round);
        return { x: r3(p.x), y: r3(p.y), evidence: "touch-indicator", confidence: 0.8 };
      }
    }
    for (let k = Math.max(1, Ts - Math.round(0.5 * fps)); k <= Tb; k++) {
      const c = compsAt(k, 6).sort((a, b) => b.pixels - a.pixels)[0];
      if (c && ch[k].changed < Math.max(0.03, peak * 0.2)) {
        const p = center(c);
        return { x: r3(p.x), y: r3(p.y), evidence: "press-feedback", confidence: 0.55 };
      }
    }
  } else {
    // Cursor: find the last frame (before the big change) where a small blob moved, then keep only
    // the part of the change where the cursor ARRIVED (differs from the window's first frame).
    const f0 = frames[0];
    for (let k = Tb; k >= Math.max(1, Tb - Math.round(1.2 * fps)); k--) {
      if (k === Tb && ch[k].changed > 0.02) continue;
      if (ch[k].changed <= tiny) continue;
      const fk = frames[k];
      const prev = frames[k - 1];
      const mask = new Uint8Array(area);
      let any = 0;
      for (let i = 0; i < area; i++) {
        if (Math.abs(fk[i] - prev[i]) > 12 && Math.abs(fk[i] - f0[i]) > 12) {
          mask[i] = 1;
          any++;
        }
      }
      if (!any) continue;
      const c = components(mask, w, h, 2)
        .filter((b) => notEdge(b) && b.w < w * 0.06 && b.h < h * 0.1)
        .sort((a, b) => b.pixels - a.pixels)[0];
      if (!c) continue;
      // The arrow tip is the top-left corner of the cursor.
      return { x: r3((c.x + 1) / w), y: r3((c.y + 1) / h), evidence: "cursor", confidence: 0.8 };
    }
    // No cursor seen: a click ripple / pressed state right at the start of the change.
    for (let k = Math.max(1, Ts - 3); k <= Tb; k++) {
      const c = compsAt(k, 4).sort((a, b) => b.pixels - a.pixels)[0];
      if (c && ch[k].changed < 0.03) {
        const p = center(c);
        return { x: r3(p.x), y: r3(p.y), evidence: "press-feedback", confidence: 0.5 };
      }
    }
  }
  return { evidence: "none", confidence: 0 };
}

function findTarget(state: StateInfo | undefined, x: number, y: number) {
  if (!state) return {};
  const pad = 0.012;
  let best: { text: string; d: number } | null = null;
  for (const l of state.text) {
    const [bx, by, bw, bh] = l.box;
    const inside = x >= bx - pad && x <= bx + bw + pad && y >= by - pad && y <= by + bh + pad;
    const dx = Math.max(bx - x, 0, x - (bx + bw));
    const dy = Math.max(by - y, 0, y - (by + bh));
    // Inside several boxes (with padding): prefer the one whose centre is closest.
    const d = inside ? Math.hypot(x - (bx + bw / 2), (y - (by + bh / 2)) * 1.5) * 0.01 : 0.01 + Math.hypot(dx, dy * 1.5);
    if (!best || d < best.d) best = { text: l.text, d };
  }
  return best && best.d < 0.07 ? { targetText: best.text, near: best.d > 0.01 } : {};
}

/** Is B the same screen with a dimmed overlay (sheet, dialog) on top? */
function overlayScore(a: Uint8Array, b: Uint8Array): number {
  // Fit b = k * a over changed pixels; a good fit with k in (0.3, 0.92) means "darkened a".
  let sab = 0;
  let saa = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 3) {
    if (Math.abs(a[i] - b[i]) < 10) continue;
    sab += a[i] * b[i];
    saa += a[i] * a[i];
    n++;
  }
  if (n < a.length / 60) return 0;
  const k = sab / Math.max(1, saa);
  if (k < 0.3 || k > 0.92) return 0;
  let fit = 0;
  for (let i = 0; i < a.length; i += 3) {
    if (Math.abs(a[i] - b[i]) < 10) continue;
    if (Math.abs(b[i] - k * a[i]) < 14) fit++;
  }
  return fit / (n || 1);
}

export async function inferFlow(pathOrUrl: string, opts: { budget?: Budget; outDir?: string; watch?: WatchResult } = {}): Promise<FlowResult> {
  const watch = opts.watch ?? (await watchVideo(pathOrUrl, { budget: opts.budget ?? "normal", outDir: opts.outDir, transcribe: false }));
  const info: VideoInfo = await probe(watch.video.path);
  const notes: string[] = [];
  const byId = new Map(watch.states.map((s) => [s.id, s]));
  const cssW = watch.cssViewport.width;
  const cssH = watch.cssViewport.height;
  const pxTarget = 110_000;
  const tw = Math.round(Math.sqrt((pxTarget * info.width) / info.height));

  // Grayscale keyframes for overlay/state classification.
  const grayOf = new Map<string, Uint8Array>();
  for (const s of watch.states) grayOf.set(s.id, toGray(await loadRaw(s.keyframe, { width: 160, height: Math.round((160 * info.height) / info.width), channels: 1 })));
  const layoutOf = new Map<string, Awaited<ReturnType<typeof layoutBoxes>>>();

  const edgesMap = new Map<string, FlowEdge>();
  const replay: Step[] = [{ action: "goto", capture: watch.timeline[0]?.state ?? "s1", pause: holdMs(watch.timeline[0]) }];
  const visitCount = new Map<string, number>();
  if (watch.timeline[0]) visitCount.set(watch.timeline[0].state, 1);
  const seenPairs: string[] = [];

  for (let i = 1; i < watch.timeline.length; i++) {
    const A = watch.timeline[i - 1];
    const B = watch.timeline[i];
    const anim = watch.animations.find((a) => a.from === A.state && a.to === B.state && a.start >= A.end - 0.4 && a.start <= B.start + 0.2);
    let trigger: Trigger;
    if (anim?.kind === "scroll") {
      trigger = { type: "scroll", scrollPx: anim.scrollPx, evidence: "scroll", confidence: 0.8 };
    } else {
      const start = Math.max(0, A.end - 1.0);
      const dur = Math.min(2.0, B.start - start + 0.2);
      const s = await sampleGray(info, { fps: 30, width: tw, start, duration: dur });
      const t = detectTrigger({ w: s.width, h: s.height, frames: s.frames, times: s.times }, anim?.start ?? A.end, watch.platform);
      trigger = { type: t.evidence === "none" ? "unknown" : watch.platform === "desktop" ? "click" : "tap", ...t };
      if (t.x !== undefined && t.y !== undefined) {
        trigger.cssX = Math.round(t.x * cssW);
        trigger.cssY = Math.round(t.y * cssH);
        const tgt = findTarget(byId.get(A.state), t.x, t.y);
        if (tgt.targetText) trigger.targetText = tgt.targetText;
        if (!layoutOf.has(A.state)) layoutOf.set(A.state, await layoutBoxes(byId.get(A.state)!.keyframe));
        const L = layoutOf.get(A.state)!;
        const under = L.boxes
          .filter((b) => t.x! >= b.x && t.x! <= b.x + b.w && t.y! >= b.y && t.y! <= b.y + b.h)
          .sort((p, q) => p.w * p.h - q.w * q.h)[0];
        if (under) trigger.targetBox = [r3(under.x), r3(under.y), r3(under.w), r3(under.h)];
      }
    }
    // Kind of edge
    let kind: FlowEdge["kind"] = trigger.type === "scroll" ? "scroll" : "navigation";
    if (kind !== "scroll") {
      const ga = grayOf.get(A.state);
      const gb = grayOf.get(B.state);
      if (ga && gb) {
        const d = diffGray(ga, gb, 160, ga.length / 160, 14);
        const H = ga.length / 160;
        if (overlayScore(ga, gb) > 0.35) kind = "overlay";
        else if (d.bbox && d.bbox.w * d.bbox.h < 160 * H * 0.25) kind = "state";
      }
      if (seenPairs.includes(`${B.state}>${A.state}`) && kind !== "state") kind = "back";
    }
    seenPairs.push(`${A.state}>${B.state}`);
    const key = `${A.state}>${B.state}`;
    const occ = { time: r3(anim?.start ?? A.end), trigger };
    const e = edgesMap.get(key);
    if (e) {
      e.occurrences.push(occ);
      if (trigger.confidence > e.trigger.confidence) e.trigger = trigger;
    } else {
      edgesMap.set(key, {
        from: A.state,
        to: B.state,
        kind,
        occurrences: [occ],
        trigger,
        ...(anim ? { animation: { kind: anim.kind, durationMs: anim.durationMs, easing: anim.easing, ...(anim.detail ? { detail: anim.detail } : {}) } } : {}),
      });
    }
    // Suggested replay step for record_build.
    const n = (visitCount.get(B.state) ?? 0) + 1;
    visitCount.set(B.state, n);
    const capture = n === 1 ? B.state : `${B.state}-visit${n}`;
    const action: Step["action"] = trigger.type === "scroll" ? "scroll" : watch.platform === "desktop" ? "click" : "tap";
    const step: Step = { action, capture, pause: holdMs(B) };
    if (action === "scroll") step.dy = trigger.scrollPx ?? 400;
    else if (trigger.x !== undefined && trigger.y !== undefined) {
      // Text is the robust target; the point is a fallback if the text isn't found.
      if (trigger.targetText && !/^\W*$/.test(trigger.targetText)) step.text = trigger.targetText;
      step.x = trigger.x;
      step.y = trigger.y;
    } else notes.push(`Couldn't see what triggered ${A.state} → ${B.state} at ${A.end.toFixed(2)}s; check that moment with get_frames.`);
    replay.push(step);
  }

  const edges = [...edgesMap.values()];
  const nodes = watch.states.map((s) => ({ id: s.id, name: s.name, keyframe: s.keyframe, thumbnail: s.thumbnail, visits: s.visits.length, firstSeen: s.visits[0]?.start ?? s.time }));
  const esc = (t: string) => t.replace(/["[\]{}()<>|]/g, " ").slice(0, 28);
  const mermaid = [
    "flowchart LR",
    ...nodes.map((n) => `  ${n.id}["${n.id}: ${esc(n.name)}"]`),
    ...edges.map((e) => {
      const label = e.trigger.type === "scroll" ? "scroll" : e.trigger.targetText ? `${e.trigger.type} '${esc(e.trigger.targetText)}'` : e.trigger.type;
      return `  ${e.from} -->|${label}| ${e.to}`;
    }),
  ].join("\n");
  const result: FlowResult = {
    video: watch.video.path,
    platform: watch.platform,
    cssViewport: watch.cssViewport,
    nodes,
    edges,
    path: watch.timeline.map((t) => t.state),
    mermaid,
    replaySteps: replay,
    notes,
  };
  writeFileSync(path.join(watch.workDir, "flow.json"), JSON.stringify(result, null, 2));
  return result;
}

function holdMs(v?: { start: number; end: number }): number {
  if (!v) return 800;
  return Math.max(300, Math.min(4000, Math.round((v.end - v.start) * 1000)));
}
