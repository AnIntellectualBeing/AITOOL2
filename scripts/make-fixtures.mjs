#!/usr/bin/env node
// Records the sample apps with Playwright to produce the test videos in fixtures/videos.
// Usage: npm run build && npm run fixtures
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordBuild } from "../dist/tools/record.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flows = JSON.parse(readFileSync(path.join(root, "fixtures/flows.json"), "utf8"));
const outDir = path.join(root, "fixtures/videos");
mkdirSync(outDir, { recursive: true });

for (const [name, flow] of Object.entries(flows)) {
  if (process.argv[2] && process.argv[2] !== name) continue;
  console.log(`Recording ${name} …`);
  const res = await recordBuild({
    serveDir: path.join(root, flow.app),
    url: flow.url,
    steps: flow.steps,
    viewport: flow.viewport,
    outDir: path.join(root, ".remake", "fixture-recordings", name),
  });
  const failed = res.steps.filter((s) => !s.ok);
  if (failed.length) throw new Error(`${name}: steps failed: ${JSON.stringify(failed)}`);
  copyFileSync(res.video, path.join(outDir, `${name}.mp4`));
  const truth = {
    name,
    viewport: res.viewport,
    duration: res.videoDuration,
    // When each action happened (seconds into the video) and what it targeted.
    actions: res.steps.map((s, i) => ({ ...flow.steps[i], time: s.time, ...(s.point ? { point: s.point } : {}) })),
    captures: res.screenshots.map((s) => ({ name: s.name, time: s.time })),
    screens: flow.screens,
  };
  writeFileSync(path.join(outDir, `${name}.truth.json`), JSON.stringify(truth, null, 2) + "\n");
  console.log(`  → fixtures/videos/${name}.mp4 (${res.videoDuration}s)`);
}
