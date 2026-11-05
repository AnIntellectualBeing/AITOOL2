import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const fixture = (p: string) => path.join(ROOT, "fixtures", p);
export const tmp = (prefix = "remake-test-") => mkdtempSync(path.join(os.tmpdir(), prefix));

export interface Truth {
  name: string;
  duration: number;
  actions: Array<{ action: string; time: number; point?: { x: number; y: number }; text?: string; label?: string; selector?: string; capture?: string }>;
  screens: string[];
}
export const truth = (name: string): Truth => JSON.parse(readFileSync(fixture(`videos/${name}.truth.json`), "utf8"));

/** A grayscale frame filled with a value, with optional rectangles drawn on it. */
export function frame(w: number, h: number, bg: number, rects: Array<{ x: number; y: number; w: number; h: number; v: number }> = []): Uint8Array {
  const f = new Uint8Array(w * h).fill(bg);
  for (const r of rects) for (let y = Math.max(0, r.y); y < Math.min(h, r.y + r.h); y++) for (let x = Math.max(0, r.x); x < Math.min(w, r.x + r.w); x++) f[y * w + x] = r.v;
  return f;
}
