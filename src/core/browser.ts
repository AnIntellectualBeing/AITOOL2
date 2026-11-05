import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import type { Browser } from "playwright-core";
import { RemakeError } from "./errors.js";
import { run } from "./exec.js";

const require = createRequire(import.meta.url);

export function browserInstallHelp(): string {
  return [
    "record_build needs a Chromium-based browser.",
    "Run `npx remake-agents doctor --fix` to download Playwright's Chromium (~150 MB),",
    "or install Google Chrome / Microsoft Edge (Remake will use it automatically).",
  ].join("\n");
}

/** Launch Chromium: Playwright's own build first, then installed Chrome / Edge. */
export async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  const attempts: Array<{ label: string; opts: Parameters<typeof chromium.launch>[0] }> = [];
  if (process.env.REMAKE_CHROMIUM) attempts.push({ label: "REMAKE_CHROMIUM", opts: { executablePath: process.env.REMAKE_CHROMIUM } });
  attempts.push({ label: "playwright chromium", opts: {} });
  attempts.push({ label: "Google Chrome", opts: { channel: "chrome" } });
  attempts.push({ label: "Microsoft Edge", opts: { channel: "msedge" } });
  if (existsSync("/opt/pw-browsers/chromium")) attempts.push({ label: "/opt/pw-browsers", opts: { executablePath: "/opt/pw-browsers/chromium" } });
  const errors: string[] = [];
  for (const a of attempts) {
    try {
      return await chromium.launch({ headless: true, ...a.opts });
    } catch (e) {
      errors.push(`${a.label}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  throw new RemakeError("browser_missing", "Couldn't start a browser to record your build.", `${browserInstallHelp()}\n(Tried: ${errors.join("; ")})`);
}

export async function installChromium(log: (s: string) => void = () => {}): Promise<void> {
  const cli = path.join(path.dirname(require.resolve("playwright-core/package.json")), "cli.js");
  log("Downloading Chromium for Playwright …");
  await run(process.execPath, [cli, "install", "chromium"], { label: "playwright install", timeoutMs: 15 * 60_000 });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

/** Tiny static file server with single-page-app fallback (for built `dist/` folders). */
export function serveStatic(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const base = path.resolve(root);
  if (!existsSync(base)) throw new RemakeError("serve_dir_missing", `Folder to serve not found: ${base}`, "Build the app first (e.g. `npm run build`) and pass its output folder.");
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let file = path.join(base, urlPath);
    if (!file.startsWith(base)) {
      res.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!existsSync(file)) {
      if (path.extname(urlPath)) {
        res.writeHead(404).end("not found");
        return;
      }
      file = path.join(base, "index.html");
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

export interface DevServer {
  child: ChildProcess;
  output: () => string;
  stop: () => Promise<void>;
}

/** Start the user's dev server (`npm run dev`, …) and wait until `url` responds. */
export async function startDevServer(command: string, cwd: string, url: string, timeoutMs = 120_000): Promise<DevServer> {
  const child = spawn(command, {
    cwd,
    shell: true,
    detached: process.platform !== "win32",
    env: { ...process.env, BROWSER: "none", CI: "1", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (c) => (out = (out + c.toString()).slice(-20_000)));
  child.stderr?.on("data", (c) => (out = (out + c.toString()).slice(-20_000)));
  const stop = async () => {
    if (child.exitCode !== null) return;
    try {
      if (process.platform === "win32") await run("taskkill", ["/pid", String(child.pid), "/T", "/F"], { allowFailure: true });
      else process.kill(-child.pid!, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new RemakeError("dev_server_exited", `The start command exited early (code ${child.exitCode}).`, `Last output:\n${out.split("\n").slice(-15).join("\n")}`);
    }
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return { child, output: () => out, stop };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await stop();
  throw new RemakeError("dev_server_timeout", `Nothing answered at ${url} within ${Math.round(timeoutMs / 1000)}s.`, `Check the port in the URL matches the dev server. Last output:\n${out.split("\n").slice(-15).join("\n")}`);
}

/**
 * Injected into every page while recording: draws a touch dot (phones) or a
 * cursor + click ripple (desktop), like "show touches" in real recordings.
 */
export function pointerOverlayScript(mode: "touch" | "cursor"): string {
  return `(() => {
  if (window.__remakeOverlay) return; window.__remakeOverlay = true;
  const mode = ${JSON.stringify(mode)};
  const style = document.createElement('style');
  style.textContent = '.__rmk{position:fixed;pointer-events:none;z-index:2147483647}html[data-remake-hide] .__rmk{display:none!important}';
  const add = () => { (document.head||document.documentElement).appendChild(style); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
  let cursor = null;
  const ensureCursor = () => {
    if (cursor || mode !== 'cursor' || !document.body) return;
    cursor = document.createElement('div'); cursor.className='__rmk';
    cursor.style.cssText += 'left:0;top:0;width:18px;height:26px;transform:translate(-100px,-100px)';
    cursor.innerHTML = '<svg width="18" height="26" viewBox="0 0 18 26"><path d="M1 1 L1 20 L6 15.5 L9.5 24 L12.5 22.8 L9 14.5 L16 14.5 Z" fill="#111" stroke="#fff" stroke-width="1.4"/></svg>';
    document.body.appendChild(cursor);
  };
  window.addEventListener('mousemove', (e) => { ensureCursor(); if (cursor) { const z = zoom(); cursor.style.transform = 'translate(' + (e.clientX / z) + 'px,' + (e.clientY / z) + 'px)'; } }, true);
  // Pages that use CSS zoom on <html> place children in zoomed units.
  const zoom = () => parseFloat(getComputedStyle(document.documentElement).zoom || '1') || 1;
  window.addEventListener('pointerdown', (e) => {
    if (!document.body) return;
    const z = zoom(); const cx = e.clientX / z, cy = e.clientY / z;
    const d = document.createElement('div'); d.className = '__rmk';
    const size = mode === 'touch' ? 44 : 30;
    d.style.cssText += 'left:' + (cx - size/2) + 'px;top:' + (cy - size/2) + 'px;width:' + size + 'px;height:' + size + 'px;border-radius:50%;' +
      (mode === 'touch' ? 'background:rgba(128,128,128,.55);border:2px solid rgba(255,255,255,.7);' : 'border:3px solid rgba(80,120,255,.8);') +
      'transition:opacity .35s ease-out, transform .35s ease-out;opacity:1';
    document.body.appendChild(d);
    requestAnimationFrame(() => requestAnimationFrame(() => { d.style.opacity = '0'; d.style.transform = 'scale(1.4)'; }));
    setTimeout(() => d.remove(), 450);
  }, true);
})();`;
}

/**
 * Records a page at full device resolution with the Chrome DevTools screencast
 * (Playwright's built-in recorder caps the size and never upscales).
 * Frames arrive only when something changes; they're re-timed into a constant
 * frame-rate MP4 on stop().
 */
export class ScreencastRecorder {
  private frames: Array<{ file: string; ts: number }> = [];
  private session: import("playwright-core").CDPSession | null = null;
  private stopped = false;
  private writes: Promise<unknown>[] = [];
  startedAt = 0;

  constructor(
    private page: import("playwright-core").Page,
    private dir: string,
    private size: { width: number; height: number },
  ) {}

  async start(): Promise<void> {
    const { mkdirSync, writeFile } = await import("node:fs");
    mkdirSync(this.dir, { recursive: true });
    this.session = await this.page.context().newCDPSession(this.page);
    this.startedAt = Date.now() / 1000;
    this.session.on("Page.screencastFrame", (ev: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
      if (this.stopped) return;
      const file = path.join(this.dir, `f${String(this.frames.length).padStart(6, "0")}.jpg`);
      const ts = ev.metadata.timestamp ?? Date.now() / 1000;
      this.frames.push({ file, ts });
      this.writes.push(new Promise((r) => writeFile(file, Buffer.from(ev.data, "base64"), r)));
      this.session?.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
    });
    await this.session.send("Page.startScreencast", {
      format: "jpeg",
      quality: 88,
      maxWidth: this.size.width,
      maxHeight: this.size.height,
      everyNthFrame: 1,
    });
  }

  /** Stop and encode. Returns the MP4 path and the wall-clock time of the first frame. */
  async stop(outMp4: string, opts: { from?: number; to?: number; fps?: number } = {}): Promise<{ path: string; firstFrameAt: number } | null> {
    this.stopped = true;
    const endTs = Date.now() / 1000;
    await this.session?.send("Page.stopScreencast").catch(() => {});
    await this.session?.detach().catch(() => {});
    await Promise.all(this.writes);
    if (!this.frames.length) return null;
    const { writeFileSync } = await import("node:fs");
    const from = opts.from ?? this.frames[0].ts;
    const to = opts.to ?? endTs;
    // Keep the last frame at or before `from` as the opening frame.
    let startIdx = 0;
    for (let i = 0; i < this.frames.length; i++) if (this.frames[i].ts <= from) startIdx = i;
    const frames = this.frames.slice(startIdx);
    const lines = ["ffconcat version 1.0"];
    for (let i = 0; i < frames.length; i++) {
      const t = Math.max(frames[i].ts, from);
      const next = i + 1 < frames.length ? Math.max(frames[i + 1].ts, from) : Math.max(to, t + 0.04);
      const dur = Math.max(0.001, next - t);
      lines.push(`file '${path.basename(frames[i].file)}'`, `duration ${dur.toFixed(4)}`);
    }
    lines.push(`file '${path.basename(frames[frames.length - 1].file)}'`);
    const list = path.join(this.dir, "frames.ffconcat");
    writeFileSync(list, lines.join("\n") + "\n");
    const { findTools, h264Args } = await import("./ffmpeg.js");
    const { ffmpeg } = findTools();
    await run(
      ffmpeg,
      [
        "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", list,
        "-vf", `fps=${opts.fps ?? 30},scale=trunc(iw/2)*2:trunc(ih/2)*2`,
        "-an", ...(await h264Args(20)), outMp4,
      ],
      { label: "ffmpeg" },
    );
    return { path: outMp4, firstFrameAt: from };
  }
}
