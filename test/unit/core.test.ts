import { describe, expect, it } from "vitest";
import { iou, layoutScore, fontSizeFromBox, typeScale } from "../../src/core/design.js";
import { components, deltaE, diffGray, hamming, phashGray, rgbToLab, ssim } from "../../src/core/image.js";
import { analyseAnimation, cubicBezierAt, fitEasing, segmentTimeline } from "../../src/core/motion.js";
import { stringSimilarity, textSimilarity } from "../../src/core/ocr.js";
import { stateKey } from "../../src/tools/compare.js";
import { guessPlatform } from "../../src/tools/watch.js";
import { frame } from "../helpers.js";

const W = 120;
const H = 200;

/** A "screen" with a header bar and a few text-like rows. */
function screen(variant: number, shiftX = 0): Uint8Array {
  const rows = Array.from({ length: 5 }, (_, i) => ({ x: 10 + shiftX, y: 40 + i * 30 + variant * 3, w: 60 + ((i * 17 + variant * 23) % 40), h: 10, v: 40 }));
  return frame(W, H, 240, [{ x: 0 + shiftX, y: 0, w: W, h: 24, v: 90 + variant * 40 }, ...rows]);
}

describe("perceptual hash", () => {
  it("is identical for identical frames and far apart for different screens", () => {
    const a = screen(0);
    const b = screen(0);
    const c = frame(W, H, 240, [{ x: 0, y: 100, w: W, h: 100, v: 20 }]);
    expect(hamming(phashGray(a, W, H), phashGray(b, W, H))).toBe(0);
    expect(hamming(phashGray(a, W, H), phashGray(c, W, H))).toBeGreaterThan(10);
  });
});

describe("ssim", () => {
  it("is 1 for identical images and lower for different ones", () => {
    const a = screen(0);
    expect(ssim(a, a, W, H).mean).toBeCloseTo(1, 5);
    expect(ssim(a, screen(2), W, H).structured).toBeLessThan(0.9);
  });
});

describe("diff + components", () => {
  it("finds the changed region", () => {
    const a = frame(W, H, 255);
    const b = frame(W, H, 255, [{ x: 30, y: 50, w: 10, h: 8, v: 0 }]);
    const d = diffGray(a, b, W, H);
    expect(d.bbox).toEqual({ x: 30, y: 50, w: 10, h: 8 });
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < mask.length; i++) mask[i] = a[i] !== b[i] ? 1 : 0;
    expect(components(mask, W, H)).toHaveLength(1);
  });
});

describe("colour", () => {
  it("deltaE is 0 for equal colours and large for different", () => {
    expect(deltaE(rgbToLab(10, 20, 30), rgbToLab(10, 20, 30))).toBe(0);
    expect(deltaE(rgbToLab(255, 0, 0), rgbToLab(0, 0, 255))).toBeGreaterThan(100);
  });
});

describe("timeline segmentation", () => {
  it("splits holds and motions", () => {
    const fps = 10;
    const frames: Uint8Array[] = [];
    for (let i = 0; i < 10; i++) frames.push(screen(0));
    for (let k = 1; k <= 3; k++) frames.push(screen(0, Math.round((k / 4) * W))); // slide out
    for (let i = 0; i < 10; i++) frames.push(screen(3));
    const s = { width: W, height: H, fps, times: frames.map((_, i) => i / fps), frames, sceneScores: frames.map(() => 0) };
    const tl = segmentTimeline(s);
    expect(tl.stable).toHaveLength(2);
    expect(tl.motions).toHaveLength(1);
    expect(tl.motions[0].start).toBeCloseTo(0.9, 1);
  });
});

describe("animation analysis", () => {
  it("recognises a new screen sliding in from the right as slide-left", () => {
    const A = screen(0);
    const B = screen(3);
    const frames = [A];
    for (let k = 1; k < 6; k++) {
      const off = Math.round(W * (1 - k / 6));
      const f = new Uint8Array(A);
      for (let y = 0; y < H; y++) for (let x = off; x < W; x++) f[y * W + x] = B[y * W + (x - off)];
      frames.push(f);
    }
    frames.push(B);
    expect(analyseAnimation(frames, W, H, null).kind).toBe("slide-left");
  });

  it("recognises a cross-fade", () => {
    const A = screen(0);
    const B = screen(3);
    const frames = [0, 0.25, 0.5, 0.75, 1].map((t) => A.map((v, i) => Math.round(v * (1 - t) + B[i] * t)));
    expect(analyseAnimation(frames, W, H, null).kind).toBe("fade");
  });

  it("fits standard easing curves", () => {
    const samples = (bez: [number, number, number, number]) => Array.from({ length: 9 }, (_, i) => ({ t: (i + 1) / 10, p: cubicBezierAt((i + 1) / 10, bez) }));
    expect(fitEasing(samples([0, 0, 0.58, 1])).name).toBe("ease-out");
    expect(fitEasing(samples([0.42, 0, 1, 1])).name).toBe("ease-in");
    expect(fitEasing(samples([0, 0, 1, 1])).name).toBe("linear");
    expect(fitEasing([{ t: 0.5, p: 1.1 }]).name).toBe("spring");
  });
});

describe("layout + text scoring", () => {
  it("scores identical layouts as 1 and disjoint ones low", () => {
    const a = [{ x: 0.1, y: 0.1, w: 0.8, h: 0.1 }, { x: 0.1, y: 0.3, w: 0.8, h: 0.2 }];
    expect(layoutScore(a, a).score).toBeCloseTo(1);
    expect(layoutScore(a, [{ x: 0.5, y: 0.7, w: 0.1, h: 0.1 }]).score).toBeLessThan(0.1);
    expect(iou(a[0], a[0])).toBe(1);
  });
  it("compares text", () => {
    expect(textSimilarity("Save changes", "save   changes!")).toBe(1);
    expect(textSimilarity("Save changes", "Submit")).toBe(0);
    expect(stringSimilarity("Good morning", "Good mornin")).toBeGreaterThan(0.9);
  });
  it("estimates font size from OCR box heights", () => {
    // "Settings" has an ascender (S) and a descender (g): the box spans ~0.96 of the font size.
    expect(fontSizeFromBox("Settings", 22)).toBeCloseTo(22.9, 0);
    expect(fontSizeFromBox("Home", 22)).toBeCloseTo(29.7, 0);
    const levels = typeScale(
      [
        { text: "Title", box: { x: 0, y: 0, w: 10, h: 22 }, confidence: 90 },
        { text: "Body text", box: { x: 0, y: 0, w: 10, h: 11 }, confidence: 90 },
      ],
      1,
    );
    expect(levels.length).toBe(2);
    expect(levels[0].sizePx).toBeGreaterThan(levels[1].sizePx);
  });
});

describe("naming helpers", () => {
  it("extracts state ids from frame names", () => {
    expect(stateKey("s3")).toBe("s3");
    expect(stateKey("s12-t001.250")).toBe("s12");
    expect(stateKey("03-s2")).toBe("s2");
    expect(stateKey("s1-visit2")).toBe("s1");
    expect(stateKey("settings")).toBeNull();
  });
  it("guesses platform and CSS scale", () => {
    expect(guessPlatform(1170, 2532)).toEqual({ platform: "phone", cssScale: 3 });
    expect(guessPlatform(780, 1688)).toEqual({ platform: "phone", cssScale: 2 });
    expect(guessPlatform(2880, 1800)).toEqual({ platform: "desktop", cssScale: 2 });
    expect(guessPlatform(1280, 800)).toEqual({ platform: "desktop", cssScale: 1 });
  });
});
