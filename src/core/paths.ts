import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where Remake keeps per-user things (downloaded tools, caches, install manifest). */
export function remakeHome(): string {
  return process.env.REMAKE_HOME ? path.resolve(process.env.REMAKE_HOME) : path.join(os.homedir(), ".remake");
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The per-project working directory (`./.remake` by default). Everything Remake
 * produces for a project (frames, contact sheets, diffs, videos) goes here and
 * a `.gitignore` keeps it out of commits.
 */
export function workRoot(outDir?: string): string {
  const dir = path.resolve(outDir ?? process.env.REMAKE_WORKDIR ?? path.join(process.cwd(), ".remake"));
  ensureDir(dir);
  const gi = path.join(dir, ".gitignore");
  if (!existsSync(gi)) {
    try {
      writeFileSync(gi, "# Created by Remake: local analysis output, never commit.\n*\n");
    } catch {
      /* read-only dirs are fine */
    }
  }
  return dir;
}

/** Stable short id for a file (path + size + mtime) so repeated calls reuse work. */
export function fileId(file: string): string {
  const st = statSync(file);
  const h = createHash("sha1").update(`${path.resolve(file)}|${st.size}|${st.mtimeMs}`).digest("hex");
  return h.slice(0, 8);
}

export function slug(s: string, max = 32): string {
  const base = s
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return base || "video";
}

/** Directory for one analysed video inside the work root. */
export function videoWorkDir(videoPath: string, outDir?: string): string {
  const dir = path.join(workRoot(outDir), `${slug(path.basename(videoPath))}-${fileId(videoPath)}`);
  return ensureDir(dir);
}

export function timestampLabel(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/** Filename-safe time, e.g. 12.345s -> "t012.345". */
export function timeTag(t: number): string {
  return `t${t.toFixed(3).padStart(7, "0")}`;
}
