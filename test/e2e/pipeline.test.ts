import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probe } from "../../src/core/ffmpeg.js";
import { shutdownOcr } from "../../src/core/ocr.js";
import { compare } from "../../src/tools/compare.js";
import { inferFlow, type FlowResult } from "../../src/tools/flow.js";
import { recordBuild, type RecordResult } from "../../src/tools/record.js";
import { makeSideBySide } from "../../src/tools/sideBySide.js";
import { getFrames, watchVideo, type WatchResult } from "../../src/tools/watch.js";
import { fixture, tmp, truth } from "../helpers.js";

const OUT = tmp("remake-e2e-");

afterAll(async () => {
  await shutdownOcr();
});

const allText = (w: WatchResult) => w.states.flatMap((s) => s.text.map((t) => t.text)).join(" | ");
const dist = (a: { x: number; y: number }, b: { x?: number; y?: number }) => Math.hypot(a.x - (b.x ?? -1), a.y - (b.y ?? -1));

interface Case {
  name: "web-app" | "phone-app";
  query: string;
  brokenQuery: string;
  viewport: "desktop" | "phone";
  path: string[];
  texts: string[];
  accent: string;
  platform: string;
}

const CASES: Case[] = [
  {
    name: "web-app",
    query: "/",
    brokenQuery: "/?broken=1",
    viewport: "desktop",
    path: ["s1", "s2", "s3", "s1"],
    texts: ["Projects", "Atlas redesign", "Settings", "Email digests", "Save changes"],
    accent: "#4f46e5",
    platform: "desktop",
  },
  {
    name: "phone-app",
    query: "/?statusbar=1",
    brokenQuery: "/?statusbar=1&broken=1",
    viewport: "phone",
    path: ["s1", "s2", "s1", "s3", "s1"],
    texts: ["Good morning", "Read 20 pages", "12 days", "New habit", "Create habit"],
    accent: "#2f8f5b",
    platform: "phone",
  },
];

function hexDist(a: string, b: string) {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

for (const c of CASES) {
  describe(`${c.name} fixture`, () => {
    const video = fixture(`videos/${c.name}.mp4`);
    const t = truth(c.name);
    let watch: WatchResult;
    let flow: FlowResult;
    let real: RecordResult;

    beforeAll(async () => {
      watch = await watchVideo(video, { outDir: OUT, budget: "normal" });
      flow = await inferFlow(video, { outDir: OUT, watch });
    });

    it("watch_video finds the 3 screens, in order, with timestamps", () => {
      expect(watch.platform).toBe(c.platform);
      expect(watch.states).toHaveLength(3);
      expect(watch.timeline.map((x) => x.state)).toEqual(c.path);
      for (const s of watch.states) expect(existsSync(s.keyframe)).toBe(true);
      // Each screen change in the video happens right after an action in the truth file.
      const actions = t.actions.filter((a) => a.action !== "goto" && a.selector === undefined);
      watch.timeline.slice(1).forEach((v, i) => {
        expect(Math.abs(v.start - actions[i].time)).toBeLessThan(0.9);
      });
    });

    it("watch_video reads the text, colours and type", () => {
      const text = allText(watch);
      for (const s of c.texts) expect(text).toContain(s);
      const accent = watch.palette.roles.accent ?? watch.palette.colors.find((x) => hexDist(x.hex, c.accent) < 40)?.hex;
      expect(accent).toBeDefined();
      expect(watch.palette.colors.some((x) => hexDist(x.hex, c.accent) < 40)).toBe(true);
      expect(watch.typeScale.length).toBeGreaterThanOrEqual(3);
      expect(watch.contactSheets.length).toBeGreaterThanOrEqual(1);
      if (c.platform === "phone") expect(watch.suggestedCrop.top).toBeGreaterThan(0.02);
    });

    it("watch_video times the transitions", () => {
      const nav = watch.animations.filter((a) => !a.inScreen);
      expect(nav.length).toBe(c.path.length - 1);
      for (const a of nav) {
        expect(a.durationMs).toBeGreaterThan(150);
        expect(a.durationMs).toBeLessThan(600);
      }
      if (c.name === "phone-app") {
        expect(nav[0].kind).toBe("slide-left"); // push in from the right
        expect(nav[1].kind).toBe("slide-right"); // back
        expect(nav[0].durationMs).toBeGreaterThanOrEqual(250);
        expect(nav[0].durationMs).toBeLessThanOrEqual(400); // CSS: 320 ms
      } else {
        for (const a of nav) expect(a.kind).toMatch(/^fade/); // CSS: opacity + translateY, 260 ms
        expect(watch.animations.some((a) => a.inScreen)).toBe(true); // the toggle switch
      }
    });

    it("get_frames returns exact frames", async () => {
      const r = await getFrames(video, [0.5, 3], { outDir: OUT, width: 200 });
      expect(r.frames).toHaveLength(2);
      for (const f of r.frames) expect(existsSync(f.path)).toBe(true);
    });

    it("infer_flow finds the graph and where the user tapped/clicked", () => {
      expect(flow.nodes).toHaveLength(3);
      expect(flow.path).toEqual(c.path);
      expect(flow.mermaid).toContain("flowchart");
      const actions = t.actions.filter((a) => a.point && a.selector === undefined);
      const occ = flow.edges.flatMap((e) => e.occurrences).sort((a, b) => a.time - b.time);
      expect(occ.length).toBe(actions.length);
      const hits = occ.filter((o, i) => dist(actions[i].point!, o.trigger) < 0.06).length;
      // Every click in the web recording; at least 3 of 4 taps on the phone.
      expect(hits).toBeGreaterThanOrEqual(c.name === "web-app" ? 3 : 3);
      if (c.name === "phone-app") {
        expect(flow.edges.find((e) => e.from === "s1" && e.to === "s3")?.kind).toBe("overlay");
        expect(flow.edges.find((e) => e.from === "s2" && e.to === "s1")?.kind).toBe("back");
      }
      expect(flow.replaySteps[0].action).toBe("goto");
      expect(flow.replaySteps).toHaveLength(c.path.length);
    });

    it("record_build replays the flow in the real app and captures each screen", async () => {
      real = await recordBuild({ serveDir: fixture(`apps/${c.name}`), url: c.query, steps: flow.replaySteps, viewport: c.viewport, outDir: `${OUT}/${c.name}-real` });
      expect(real.steps.every((s) => s.ok)).toBe(true);
      expect(real.screenshots.map((s) => s.name)).toEqual(flow.replaySteps.map((s) => s.capture));
      expect(real.pageErrors).toEqual([]);
      expect(real.video && existsSync(real.video)).toBe(true);
      const info = await probe(real.video!);
      expect(info.duration).toBeGreaterThan(3);
    });

    it("compare scores the real app high and a deliberately broken copy low", async () => {
      const broken = await recordBuild({ serveDir: fixture(`apps/${c.name}`), url: c.brokenQuery, steps: flow.replaySteps, viewport: c.viewport, video: false, outDir: `${OUT}/${c.name}-broken` });
      const original = watch.states.map((s) => ({ path: s.keyframe, name: s.id }));
      const firstVisits = (r: RecordResult) => r.screenshots.filter((s) => !s.name.includes("visit")).map((s) => ({ path: s.path, name: s.name }));
      // Both builds keep the fixture's fake status bar, so crop it from both sides.
      const crop = watch.suggestedCrop;
      const good = await compare({ original, build: firstVisits(real), crop, buildCrop: crop, outDir: `${OUT}/${c.name}-cmp-real` });
      const bad = await compare({ original, build: firstVisits(broken), crop, buildCrop: crop, outDir: `${OUT}/${c.name}-cmp-broken` });
      expect(good.total).toBe(3);
      expect(good.overall).toBeGreaterThanOrEqual(0.9);
      expect(good.allPass).toBe(true);
      expect(bad.overall).toBeLessThan(good.overall - 0.1);
      expect(bad.total - bad.passed).toBeGreaterThanOrEqual(2);
      // The broken copy's diffs point at real problems.
      const hints = bad.pairs.flatMap((p) => p.mismatches.map((m) => m.hint)).join(" ");
      expect(hints).toMatch(/colour|missing|text differs/);
      for (const p of bad.pairs) expect(existsSync(p.diffImage)).toBe(true);
    });

    it("make_side_by_side makes 16:9 and 9:16 videos with the label on by default", async () => {
      const om = watch.timeline.slice(1).map((v, i) => watch.timeline[i].end);
      const bm = real.steps.slice(1).map((s) => s.time);
      const r = await makeSideBySide({ original: video, build: real.video!, originalMarks: om, buildMarks: bm, outDir: `${OUT}/${c.name}-sbs` });
      expect(r.watermark).toBe(true);
      expect(r.sync).toBe("segments");
      expect(r.videos.map((v) => v.layout).sort()).toEqual(["16:9", "9:16"]);
      for (const v of r.videos) {
        const info = await probe(v.path);
        expect([info.width, info.height]).toEqual(v.layout === "16:9" ? [1920, 1080] : [1080, 1920]);
        expect(Math.abs(info.duration - watch.video.duration)).toBeLessThan(1.5);
      }
      const plain = await makeSideBySide({ original: video, build: real.video!, layouts: ["16:9"], watermark: false, outDir: `${OUT}/${c.name}-sbs-nowm` });
      expect(plain.watermark).toBe(false);
    });
  });
}
