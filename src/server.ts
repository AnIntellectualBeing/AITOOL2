import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import sharp from "sharp";
import { z } from "zod";
import { describeError } from "./core/errors.js";
import { shutdownOcr } from "./core/ocr.js";
import { skillText, VERSION } from "./meta.js";
import { compare } from "./tools/compare.js";
import { inferFlow } from "./tools/flow.js";
import { recordBuild, type Step } from "./tools/record.js";
import { makeSideBySide } from "./tools/sideBySide.js";
import { getFrames, watchVideo, type WatchResult } from "./tools/watch.js";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const INSTRUCTIONS = `Remake turns a screen recording of an app into a working copy.
Workflow: watch_video → write a SPEC and confirm the stack with the user → build screen by screen → record_build → compare → fix the worst mismatches → repeat → make_side_by_side.
Use the "remake" prompt (or the Remake skill) for the full playbook. Replace logos, brand names and trademarked icons with neutral placeholders by default.
All files are written under ./.remake in the project. Images are also returned inline; if your client can't show them, open the listed paths.`;

async function imageContent(file: string, maxWidth = 1600): Promise<Content> {
  const meta = await sharp(file).metadata();
  const w = meta.width ?? maxWidth;
  const buf = w > maxWidth || !/\.jpe?g$/i.test(file) ? await sharp(file).resize({ width: Math.min(w, maxWidth) }).jpeg({ quality: 80 }).toBuffer() : readFileSync(file);
  return { type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" };
}

function text(obj: unknown): Content {
  return { type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 1) };
}

function fail(err: unknown) {
  return { isError: true, content: [text(`Remake error: ${describeError(err)}`)] };
}

function progressReporter(extra: { _meta?: { progressToken?: string | number }; sendNotification: (n: any) => Promise<void> }) {
  const token = extra._meta?.progressToken;
  return (message: string, fraction?: number) => {
    if (token === undefined) return;
    extra
      .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: Math.round((fraction ?? 0) * 100), total: 100, message } })
      .catch(() => {});
  };
}

/** A compact view of watch results for the agent (full JSON is on disk). */
export function summariseWatch(r: WatchResult) {
  return {
    video: r.video,
    platform: r.platform,
    cssViewport: r.cssViewport,
    cssScale: r.cssScale,
    suggestedCrop: r.suggestedCrop,
    states: r.states.map((s) => ({
      id: s.id,
      name: s.name,
      keyframe: s.keyframe,
      time: s.time,
      visits: s.visits.length,
      text: s.text.map((t) => `${t.text}  @[${t.box.join(",")}]${t.sizePx ? ` ~${t.sizePx}px` : ""}`),
    })),
    timeline: r.timeline.map((t) => `${t.state} ${t.start.toFixed(2)}–${t.end.toFixed(2)}s`),
    animations: r.animations,
    palette: r.palette,
    typeScale: r.typeScale,
    spacing: r.spacing,
    transcript: r.transcript.status === "ok" ? r.transcript.segments : r.transcript.status,
    contactSheets: r.contactSheets.map((c) => ({ path: c.path, shows: c.shows })),
    analysisFile: `${r.workDir}/analysis-${r.budget}.json`,
    notes: r.notes,
  };
}

const crop = z.object({ top: z.number().min(0).max(0.5).optional(), bottom: z.number().min(0).max(0.5).optional() }).optional();
const frameRef = z.union([z.string(), z.object({ path: z.string(), name: z.string().optional() })]);
const step = z
  .object({
    action: z.enum(["goto", "click", "tap", "hover", "type", "press", "scroll", "wait", "screenshot", "back"]),
    url: z.string().optional(),
    selector: z.string().optional(),
    text: z.string().optional(),
    label: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    value: z.string().optional(),
    key: z.string().optional(),
    dy: z.number().optional(),
    dx: z.number().optional(),
    ms: z.number().optional(),
    capture: z.string().optional(),
    pause: z.number().optional(),
  })
  .passthrough();

export function createServer(): McpServer {
  const server = new McpServer({ name: "remake", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "watch_video",
    {
      title: "Watch a screen recording",
      description:
        "Analyse a screen recording (MP4/MOV/WEBM file, or a YouTube/Loom link you have rights to). Finds every distinct UI state with timestamps (scene detection + perceptual-hash dedupe), returns keyframes as contact sheets (grids, to save tokens), animation timings (start, duration, kind, easing), OCR text with boxes, colour palette, approximate type scale and spacing, and a narration transcript if a local whisper is installed. Budget: low | normal | high detail.",
      inputSchema: {
        path_or_url: z.string().describe("Local video path or a YouTube/Loom URL"),
        budget: z.enum(["low", "normal", "high"]).default("normal").describe("How much detail (and tokens) to spend"),
        transcribe: z.boolean().default(true),
        out_dir: z.string().optional().describe("Where to write analysis files (default ./.remake)"),
        force: z.boolean().default(false).describe("Re-analyse even if cached"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        const r = await watchVideo(args.path_or_url, { budget: args.budget, transcribe: args.transcribe, outDir: args.out_dir, force: args.force, onProgress: progressReporter(extra as any) });
        const content: Content[] = [text(summariseWatch(r))];
        for (const c of r.contactSheets) content.push(await imageContent(c.path));
        return { content };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_frames",
    {
      title: "Get exact frames",
      description: "Extract exact frames at the given timestamps (seconds) to zoom into a moment. Returns file paths (full resolution PNG) and inline previews.",
      inputSchema: {
        path: z.string(),
        timestamps: z.array(z.number().min(0)).min(1).max(24),
        width: z.number().int().min(64).max(4096).optional().describe("Resize to this width (default: original size)"),
        inline: z.boolean().default(true).describe("Return the images inline too"),
        out_dir: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const r = await getFrames(args.path, args.timestamps, { width: args.width, outDir: args.out_dir });
        const content: Content[] = [text(r)];
        if (args.inline) for (const f of r.frames.slice(0, 8)) content.push(await imageContent(f.path, 900));
        return { content };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "infer_flow",
    {
      title: "Infer the navigation flow",
      description:
        "Build a navigation graph of screens and transitions from the recording, with the probable trigger of each transition (tap/click location from frame differences, cursor or touch-indicator detection), the text under it, the transition animation, a mermaid diagram, and suggested replay steps for record_build.",
      inputSchema: { path: z.string(), budget: z.enum(["low", "normal", "high"]).default("normal"), out_dir: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return { content: [text(await inferFlow(args.path, { budget: args.budget, outDir: args.out_dir }))] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "record_build",
    {
      title: "Record the build",
      description:
        "Run the built app in a real browser (Playwright; phone-sized viewport for phone recordings), replay the flow, capture a screenshot at each step that has `capture` set (name it after the original state id, e.g. \"s2\"), and record a video. Give a url, or serve_dir (a built folder), or start_command + url. Steps: goto, click/tap (by text, label, selector, or x/y where 0..1 = fraction of the viewport), type, press, scroll, wait, back, screenshot.",
      inputSchema: {
        url: z.string().optional(),
        steps: z.array(step).min(1),
        viewport: z.union([z.enum(["phone", "tablet", "desktop"]), z.object({ width: z.number(), height: z.number(), deviceScaleFactor: z.number().optional(), mobile: z.boolean().optional() })]).default("desktop"),
        serve_dir: z.string().optional(),
        start_command: z.string().optional(),
        cwd: z.string().optional(),
        video: z.boolean().default(true),
        show_pointer: z.boolean().default(true),
        color_scheme: z.enum(["light", "dark"]).optional(),
        out_dir: z.string().optional(),
        label: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const r = await recordBuild({
          url: args.url,
          steps: args.steps as Step[],
          viewport: args.viewport,
          serveDir: args.serve_dir,
          startCommand: args.start_command,
          cwd: args.cwd,
          video: args.video,
          showPointer: args.show_pointer,
          colorScheme: args.color_scheme,
          outDir: args.out_dir,
          label: args.label,
        });
        return { content: [text(r)] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "compare",
    {
      title: "Compare build to original",
      description:
        "Score each build screenshot against the matching original frame (paired by state id in the names, e.g. s1 ↔ s1, else by order or similarity). Per screen: overall score, visual (structural similarity), layout (box overlap), colour (ΔE), text (OCR) — plus a diff image and a ranked list of the biggest mismatches with hints. A screen passes when score ≥ threshold and no metric is below min_metric.",
      inputSchema: {
        original_frames: z.array(frameRef).min(1),
        build_frames: z.array(frameRef).min(1),
        crop: crop.describe("Crop for original frames, e.g. watch_video's suggestedCrop (status bar)"),
        build_crop: crop,
        threshold: z.number().min(0).max(1).default(0.85),
        min_metric: z.number().min(0).max(1).default(0.6),
        pairing: z.enum(["auto", "order", "name", "similarity"]).default("auto"),
        inline_diffs: z.number().int().min(0).max(6).default(3).describe("How many diff images (worst first) to return inline"),
        out_dir: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const r = await compare({
          original: args.original_frames,
          build: args.build_frames,
          crop: args.crop,
          buildCrop: args.build_crop,
          threshold: args.threshold,
          minMetric: args.min_metric,
          pairing: args.pairing,
          outDir: args.out_dir,
        });
        const content: Content[] = [text(r)];
        for (const p of r.pairs.filter((x) => !x.pass).slice(0, args.inline_diffs)) content.push(await imageContent(p.diffImage, 1400));
        return { content };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "make_side_by_side",
    {
      title: "Make a side-by-side video",
      description:
        "Make original-vs-remake comparison videos in 9:16 and 16:9 (and optionally a GIF), with a small \"Made with Remake\" label (on by default; set watermark=false to remove). By default the screen changes in both videos are detected and lined up; or pass matching original_marks/build_marks.",
      inputSchema: {
        original: z.string(),
        build: z.string(),
        layouts: z.array(z.enum(["16:9", "9:16"])).optional(),
        watermark: z.boolean().default(true),
        sync: z.enum(["auto", "segments", "stretch", "pad"]).optional().describe("auto (default): line up the screen changes found in both videos"),
        original_marks: z.array(z.number()).optional().describe("Seconds in the original where each transition starts"),
        build_marks: z.array(z.number()).optional().describe("Matching seconds in the build video (record_build step times)"),
        labels: z.object({ original: z.string().optional(), build: z.string().optional() }).optional(),
        gif: z.boolean().default(false),
        out_dir: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const r = await makeSideBySide({
          original: args.original,
          build: args.build,
          layouts: args.layouts,
          watermark: args.watermark,
          sync: args.sync,
          originalMarks: args.original_marks,
          buildMarks: args.build_marks,
          labels: args.labels,
          gif: args.gif,
          outDir: args.out_dir,
        });
        return { content: [text(r)] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerPrompt(
    "remake",
    {
      title: "Remake an app from a screen recording",
      description: "The full Remake playbook: watch the video, write a spec, build, check against the original, fix, and make a side-by-side video.",
      argsSchema: { video: z.string().optional().describe("Path or link to the screen recording") },
    },
    async (args) => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: `${skillText()}\n\n---\n${args.video ? `The recording to remake: ${args.video}` : "Ask me for the recording to remake (a file path or a YouTube/Loom link)."}` },
        },
      ],
    }),
  );

  return server;
}

export async function runServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = async () => {
    await shutdownOcr();
    process.exit(0);
  };
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
