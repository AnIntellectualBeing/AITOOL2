import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { RemakeError } from "./errors.js";
import { run, which } from "./exec.js";
import { ensureDir, remakeHome } from "./paths.js";

export interface Tools {
  ffmpeg: string;
  ffprobe: string;
  source: "env" | "path" | "remake-download";
}

let cached: Tools | null = null;

function privateToolsDir(): string {
  return path.join(remakeHome(), "tools");
}

function fromPrivateInstall(): { ffmpeg?: string; ffprobe?: string } {
  const dir = privateToolsDir();
  const pkg = path.join(dir, "package.json");
  if (!existsSync(pkg)) return {};
  const req = createRequire(pkg);
  const out: { ffmpeg?: string; ffprobe?: string } = {};
  try {
    const p = req("ffmpeg-static") as string | null;
    if (p && existsSync(p)) out.ffmpeg = p;
  } catch {
    /* not installed */
  }
  try {
    const p = (req("ffprobe-static") as { path: string }).path;
    if (p && existsSync(p)) out.ffprobe = p;
  } catch {
    /* not installed */
  }
  return out;
}

export function ffmpegInstallHelp(): string {
  const lines = [
    "Remake needs ffmpeg (a free video tool) to read your recording.",
    "Fastest fix: run `npx remake-agents doctor --fix` to download a private copy into ~/.remake/tools (about 80 MB, nothing else on your system changes).",
    "Or install it yourself:",
  ];
  if (process.platform === "darwin") lines.push("  macOS:   brew install ffmpeg");
  else if (process.platform === "win32") lines.push("  Windows: winget install Gyan.FFmpeg   (then open a new terminal)");
  else lines.push("  Linux:   sudo apt install ffmpeg   (or: sudo dnf install ffmpeg / sudo pacman -S ffmpeg)");
  lines.push("You can also point Remake at existing binaries with REMAKE_FFMPEG=/path/to/ffmpeg and REMAKE_FFPROBE=/path/to/ffprobe.");
  return lines.join("\n");
}

/** Locate ffmpeg + ffprobe, or throw a plain-language error explaining how to get them. */
export function findTools(): Tools {
  if (cached) return cached;
  const envF = process.env.REMAKE_FFMPEG;
  const envP = process.env.REMAKE_FFPROBE;
  if (envF && existsSync(envF)) {
    const probe = envP && existsSync(envP) ? envP : path.join(path.dirname(envF), path.basename(envF).replace("ffmpeg", "ffprobe"));
    if (existsSync(probe)) return (cached = { ffmpeg: envF, ffprobe: probe, source: "env" });
  }
  const f = which("ffmpeg");
  const p = which("ffprobe");
  if (f && p) return (cached = { ffmpeg: f, ffprobe: p, source: "path" });
  const priv = fromPrivateInstall();
  if (priv.ffmpeg && priv.ffprobe) return (cached = { ffmpeg: priv.ffmpeg, ffprobe: priv.ffprobe, source: "remake-download" });
  throw new RemakeError("ffmpeg_missing", "ffmpeg was not found on this computer.", ffmpegInstallHelp());
}

export function resetToolCache(): void {
  cached = null;
}

/** Download static ffmpeg/ffprobe builds into ~/.remake/tools using npm (first-run helper). */
export async function installPrivateFfmpeg(log: (s: string) => void = () => {}): Promise<Tools> {
  const dir = ensureDir(privateToolsDir());
  const pkg = path.join(dir, "package.json");
  if (!existsSync(pkg)) writeFileSync(pkg, JSON.stringify({ name: "remake-private-tools", private: true }, null, 2));
  mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  log(`Downloading ffmpeg + ffprobe into ${dir} …`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await run(npm, ["install", "--no-audit", "--no-fund", "--prefix", dir, "ffmpeg-static@^5", "ffprobe-static@^3"], {
    label: "npm install ffmpeg-static",
    timeoutMs: 10 * 60_000,
    env: process.env,
  }).catch((e) => {
    throw new RemakeError("ffmpeg_download_failed", `Downloading ffmpeg failed: ${(e as Error).message}`, ffmpegInstallHelp());
  });
  resetToolCache();
  return findTools();
}

export interface VideoInfo {
  path: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  codec: string;
}

/** Read duration, size (after rotation), frame rate and whether there is audio. */
export async function probe(file: string): Promise<VideoInfo> {
  if (!existsSync(file)) throw new RemakeError("file_missing", `Video file not found: ${file}`, "Check the path. Use an absolute path if unsure.");
  const { ffprobe } = findTools();
  const res = await run(ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], {
    label: "ffprobe",
  }).catch(() => {
    throw new RemakeError("not_a_video", `Could not read ${path.basename(file)} as a video.`, "Use an MP4, MOV, WEBM or MKV screen recording.");
  });
  const j = JSON.parse(res.stdout.toString("utf8")) as {
    streams: Array<Record<string, any>>;
    format: Record<string, any>;
  };
  const v = j.streams.find((s) => s.codec_type === "video");
  if (!v) throw new RemakeError("no_video_stream", `${path.basename(file)} has no video track.`);
  let width = Number(v.width);
  let height = Number(v.height);
  let rotation = 0;
  if (v.tags?.rotate) rotation = Number(v.tags.rotate);
  for (const sd of v.side_data_list ?? []) if (sd.rotation !== undefined) rotation = Number(sd.rotation);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  const rate = String(v.avg_frame_rate && v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v.r_frame_rate ?? "30/1");
  const [num, den] = rate.split("/").map(Number);
  let fps = den ? num / den : num;
  if (!isFinite(fps) || fps <= 0 || fps > 240) fps = 30;
  let duration = Number(j.format?.duration ?? v.duration);
  if (!isFinite(duration) || duration <= 0) duration = Number(v.nb_frames) / fps || 0;
  return {
    path: file,
    duration,
    width,
    height,
    fps,
    hasAudio: j.streams.some((s) => s.codec_type === "audio"),
    codec: String(v.codec_name ?? "unknown"),
  };
}

export interface GraySamples {
  width: number;
  height: number;
  fps: number;
  times: number[];
  frames: Uint8Array[];
  /** ffmpeg scdet scene-change score (0-100) per sampled frame. */
  sceneScores: number[];
}

export function evenHeight(width: number, srcW: number, srcH: number): number {
  return Math.max(2, Math.round((width * srcH) / srcW / 2) * 2);
}

/**
 * Decode the video at a fixed rate into small grayscale frames (in memory), and
 * collect ffmpeg's own scene-change score (scdet) for each frame in the same pass.
 */
export async function sampleGray(
  info: VideoInfo,
  opts: { fps: number; width: number; start?: number; duration?: number; maxFrames?: number },
): Promise<GraySamples> {
  const { ffmpeg } = findTools();
  const width = Math.max(16, Math.round(opts.width / 2) * 2);
  const height = evenHeight(width, info.width, info.height);
  const frameSize = width * height;
  const args = ["-hide_banner", "-nostdin", "-loglevel", "info"];
  if (opts.start && opts.start > 0) args.push("-ss", opts.start.toFixed(3));
  args.push("-i", info.path);
  if (opts.duration) args.push("-t", opts.duration.toFixed(3));
  if (opts.maxFrames) args.push("-frames:v", String(opts.maxFrames));
  args.push(
    "-an",
    "-vf",
    `fps=${opts.fps},scale=${width}:${height}:flags=area,format=gray,scdet=threshold=8,metadata=mode=print:key=lavfi.scd.score`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "pipe:1",
  );
  const frames: Uint8Array[] = [];
  let pending: Buffer = Buffer.alloc(0);
  const scores: number[] = [];
  await run(ffmpeg, args, {
    label: "ffmpeg",
    maxStderr: 50_000,
    onStdout: (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameSize) {
        frames.push(new Uint8Array(pending.subarray(0, frameSize)));
        pending = pending.subarray(frameSize);
      }
    },
    onStderrLine: (line) => {
      const m = line.match(/lavfi\.scd\.score=([\d.]+)/);
      if (m) scores.push(Number(m[1]));
    },
  });
  const start = opts.start ?? 0;
  const times = frames.map((_, i) => start + i / opts.fps);
  while (scores.length < frames.length) scores.push(0);
  return { width, height, fps: opts.fps, times, frames, sceneScores: scores.slice(0, frames.length) };
}

/** Extract one exact frame as PNG/JPEG (optionally scaled to `width`). */
export async function extractFrame(file: string, t: number, outPath: string, width?: number): Promise<string> {
  const { ffmpeg } = findTools();
  ensureDir(path.dirname(outPath));
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", Math.max(0, t).toFixed(3), "-i", file, "-frames:v", "1", "-an"];
  if (width) args.push("-vf", `scale=${Math.round(width / 2) * 2}:-2:flags=lanczos`);
  if (outPath.endsWith(".jpg") || outPath.endsWith(".jpeg")) args.push("-q:v", "3");
  args.push(outPath);
  await run(ffmpeg, args, { label: "ffmpeg" });
  if (!existsSync(outPath)) {
    // Seeking past the last frame produces nothing: retry slightly earlier.
    if (t > 0.1) return extractFrame(file, t - 0.1, outPath, width);
    throw new RemakeError("frame_failed", `Could not extract a frame at ${t.toFixed(2)}s from ${path.basename(file)}.`);
  }
  return outPath;
}

/** Does the encoder exist in this ffmpeg build? */
export async function hasEncoder(name: string): Promise<boolean> {
  const { ffmpeg } = findTools();
  const r = await run(ffmpeg, ["-hide_banner", "-encoders"], { allowFailure: true, label: "ffmpeg" });
  return r.stdout.toString().includes(` ${name} `);
}

let h264: boolean | null = null;
export async function h264Args(crf = 23): Promise<string[]> {
  if (h264 === null) h264 = await hasEncoder("libx264");
  return h264
    ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    : ["-c:v", "mpeg4", "-q:v", "4", "-pix_fmt", "yuv420p"];
}

/** Convert any video (e.g. Playwright's WebM) to a widely playable MP4. */
export async function toMp4(input: string, output: string, opts: { trimStart?: number } = {}): Promise<string> {
  const { ffmpeg } = findTools();
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
  if (opts.trimStart && opts.trimStart > 0) args.push("-ss", opts.trimStart.toFixed(3));
  args.push("-i", input, "-an", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", ...(await h264Args(20)), output);
  await run(ffmpeg, args, { label: "ffmpeg" });
  return output;
}
