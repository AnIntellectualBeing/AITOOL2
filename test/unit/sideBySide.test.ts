import { describe, expect, it } from "vitest";
import { detectTrigger } from "../../src/tools/flow.js";
import { planLayout, segmentFilter } from "../../src/tools/sideBySide.js";
import { frame } from "../helpers.js";

describe("side-by-side layout", () => {
  it("puts two phone recordings next to each other in both formats", () => {
    expect(planLayout("16:9", { w: 1170, h: 2532 }, { w: 390, h: 844 }).dir).toBe("row");
    expect(planLayout("9:16", { w: 1170, h: 2532 }, { w: 390, h: 844 }).dir).toBe("row");
  });
  it("stacks two desktop recordings in 9:16 and puts them side by side in 16:9", () => {
    expect(planLayout("9:16", { w: 1920, h: 1080 }, { w: 1280, h: 800 }).dir).toBe("column");
    expect(planLayout("16:9", { w: 1920, h: 1080 }, { w: 1280, h: 800 }).dir).toBe("row");
  });
  it("builds a segment re-timing filter", () => {
    const f = segmentFilter("[1:v]", "[bs]", [2, 4], [3, 5], 6, 8);
    expect(f.filter).toContain("split=3");
    expect(f.filter).toContain("concat=n=3");
    // segment 1: 0-3s stretched to 2s
    expect(f.filter).toContain("setpts=(PTS-STARTPTS)*0.6667");
    expect(f.duration).toBeCloseTo(6, 1);
  });
});

describe("trigger detection", () => {
  it("finds a touch dot that appears just before a screen change", () => {
    const W = 100;
    const H = 200;
    const a = frame(W, H, 240, [{ x: 10, y: 20, w: 80, h: 10, v: 30 }]);
    const dot = frame(W, H, 240, [{ x: 10, y: 20, w: 80, h: 10, v: 30 }, { x: 60, y: 120, w: 10, h: 10, v: 150 }]);
    const b = frame(W, H, 30, [{ x: 0, y: 0, w: 100, h: 40, v: 200 }]);
    const frames = [a, a, a, a, dot, dot, b, b];
    const times = frames.map((_, i) => i / 30);
    const t = detectTrigger({ w: W, h: H, frames, times }, 6 / 30, "phone");
    expect(t.evidence).toBe("touch-indicator");
    expect(t.x).toBeCloseTo(0.645, 1);
    expect(t.y).toBeCloseTo(0.6225, 1);
  });
});
