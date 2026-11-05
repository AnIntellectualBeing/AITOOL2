import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { RemakeError } from "./errors.js";
import { run, which } from "./exec.js";
import { ensureDir, workRoot } from "./paths.js";
import { createHash } from "node:crypto";

export function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

export function ytDlpHelp(): string {
  const lines = ["Links (YouTube, Loom, …) are downloaded with yt-dlp, which isn't installed."];
  if (process.platform === "darwin") lines.push("  macOS:   brew install yt-dlp");
  else if (process.platform === "win32") lines.push("  Windows: winget install yt-dlp.yt-dlp");
  else lines.push("  Linux:   pipx install yt-dlp   (or: sudo apt install yt-dlp)");
  lines.push("Or download the video yourself and pass the file path instead.");
  return lines.join("\n");
}

/**
 * Download a video link to the local work dir with yt-dlp. Only use this for
 * content you own or have the rights to use.
 */
export async function downloadVideo(url: string, outDir?: string): Promise<string> {
  const ytdlp = process.env.REMAKE_YTDLP ?? which("yt-dlp") ?? which("yt_dlp");
  if (!ytdlp) throw new RemakeError("ytdlp_missing", "Can't download links without yt-dlp.", ytDlpHelp());
  const id = createHash("sha1").update(url.trim()).digest("hex").slice(0, 10);
  const dir = ensureDir(path.join(workRoot(outDir), "downloads", id));
  const existing = readdirSync(dir).find((f) => /\.(mp4|mkv|webm|mov)$/i.test(f) && !f.includes(".part"));
  if (existing) return path.join(dir, existing);
  await run(
    ytdlp,
    [
      "--no-playlist",
      "--no-progress",
      "-f",
      "bv*[height<=1440][ext=mp4]+ba[ext=m4a]/b[height<=1440][ext=mp4]/bv*[height<=1440]+ba/b",
      "--merge-output-format",
      "mp4",
      "-o",
      path.join(dir, "video.%(ext)s"),
      url,
    ],
    { label: "yt-dlp", timeoutMs: 15 * 60_000 },
  ).catch((e) => {
    throw new RemakeError(
      "download_failed",
      `Couldn't download that link: ${(e as Error).message.split("\n").slice(-1)[0]}`,
      "Check the link is public (or that you're signed in for private Loom videos), or download it yourself and pass the file path.",
    );
  });
  const file = readdirSync(dir).find((f) => /\.(mp4|mkv|webm|mov)$/i.test(f) && !f.includes(".part"));
  if (!file || !existsSync(path.join(dir, file))) throw new RemakeError("download_failed", "yt-dlp finished but no video file was produced.");
  return path.join(dir, file);
}
