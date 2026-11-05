import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import { launchBrowser, pointerOverlayScript, ScreencastRecorder, serveStatic, startDevServer, type DevServer } from "../core/browser.js";
import { RemakeError } from "../core/errors.js";
import { probe } from "../core/ffmpeg.js";
import { ensureDir, workRoot } from "../core/paths.js";

export type StepAction = "goto" | "click" | "tap" | "hover" | "type" | "press" | "scroll" | "wait" | "screenshot" | "back";

export interface Step {
  action: StepAction;
  /** goto: absolute URL or a path relative to the app URL. */
  url?: string;
  /** CSS / Playwright selector. */
  selector?: string;
  /** Visible text of the element to act on. */
  text?: string;
  /** Accessible label (aria-label / label text). */
  label?: string;
  /** Point to act on: 0..1 = fraction of the viewport, >1 = CSS pixels. */
  x?: number;
  y?: number;
  /** type: text to enter. press: key name (e.g. "Enter"). */
  value?: string;
  key?: string;
  /** scroll: pixels (positive = down / right). */
  dy?: number;
  dx?: number;
  /** wait: milliseconds. */
  ms?: number;
  /** Take a screenshot with this name once the UI settles after this step. */
  capture?: string;
  /** Extra hold after the step, for natural pacing in the video (ms, default 500). */
  pause?: number;
}

export type ViewportPreset = "phone" | "tablet" | "desktop";

export interface RecordOptions {
  url?: string;
  steps: Step[];
  viewport?: ViewportPreset | { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean };
  /** Start the app first, e.g. "npm run dev". */
  startCommand?: string;
  cwd?: string;
  /** Or serve a built folder (dist/, web-build/) on a local port. */
  serveDir?: string;
  video?: boolean;
  showPointer?: boolean;
  colorScheme?: "light" | "dark";
  outDir?: string;
  label?: string;
  settleMs?: number;
  stepTimeoutMs?: number;
}

export interface RecordResult {
  url: string;
  outDir: string;
  viewport: { width: number; height: number; deviceScaleFactor: number; mobile: boolean };
  screenshots: Array<{ name: string; path: string; time: number; step: number }>;
  video?: string;
  videoDuration?: number;
  steps: Array<{ index: number; action: StepAction; time: number; ok: boolean; error?: string; point?: { x: number; y: number } }>;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
}

export const VIEWPORTS: Record<ViewportPreset, { width: number; height: number; deviceScaleFactor: number; mobile: boolean }> = {
  phone: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
};

function resolveViewport(v: RecordOptions["viewport"]) {
  if (!v) return VIEWPORTS.desktop;
  if (typeof v === "string") {
    const p = VIEWPORTS[v];
    if (!p) throw new RemakeError("bad_viewport", `Unknown viewport "${v}".`, 'Use "phone", "tablet", "desktop" or {width, height}.');
    return p;
  }
  return { width: Math.round(v.width), height: Math.round(v.height), deviceScaleFactor: v.deviceScaleFactor ?? (v.width < 700 ? 2 : 1), mobile: v.mobile ?? v.width < 700 };
}

async function settle(page: Page, maxMs: number): Promise<boolean> {
  const start = Date.now();
  let prev: Buffer | null = null;
  await page.waitForTimeout(60);
  while (Date.now() - start < maxMs) {
    let buf: Buffer;
    try {
      buf = await page.screenshot({ type: "jpeg", quality: 40, scale: "css", caret: "hide", animations: "allow", timeout: 5000 });
    } catch {
      return false;
    }
    if (prev && buf.equals(prev)) return true;
    prev = buf;
    await page.waitForTimeout(90);
  }
  return false;
}

function locate(page: Page, s: Step): Locator | null {
  if (s.selector) return page.locator(s.selector).first();
  if (s.label) return page.getByLabel(s.label, { exact: false }).first();
  if (s.text) {
    // Prefer exact text, then any element containing the text.
    return page.getByText(s.text, { exact: true }).or(page.getByText(s.text)).first();
  }
  return null;
}

function point(s: Step, vp: { width: number; height: number }): { x: number; y: number } | null {
  if (s.x === undefined || s.y === undefined) return null;
  return { x: s.x <= 1 ? s.x * vp.width : s.x, y: s.y <= 1 ? s.y * vp.height : s.y };
}

/** Run the built app in a real browser, replay the flow, capture screenshots and a video. */
export async function recordBuild(opts: RecordOptions): Promise<RecordResult> {
  if (!opts.steps?.length) throw new RemakeError("no_steps", "record_build needs at least one step.", 'Start with {"action":"goto","capture":"s1"}.');
  const vp = resolveViewport(opts.viewport);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = opts.outDir
    ? ensureDir(path.resolve(opts.outDir))
    : ensureDir(path.join(workRoot(), "builds", `${opts.label ? opts.label.replace(/[^a-z0-9-]+/gi, "-") + "-" : ""}${stamp}`));
  const shotsDir = ensureDir(path.join(outDir, "shots"));
  const rawVideoDir = path.join(outDir, "raw-frames");

  let dev: DevServer | null = null;
  let staticServer: { url: string; close: () => Promise<void> } | null = null;
  let baseUrl = opts.url ?? "";
  if (opts.serveDir) {
    staticServer = await serveStatic(opts.serveDir);
    baseUrl = new URL(opts.url && !/^https?:/.test(opts.url) ? opts.url.replace(/^\//, "") : "", staticServer.url).toString();
  } else if (opts.startCommand) {
    if (!opts.url) throw new RemakeError("no_url", "With start_command, also pass the url the dev server will listen on (e.g. http://localhost:5173).");
    dev = await startDevServer(opts.startCommand, path.resolve(opts.cwd ?? process.cwd()), opts.url);
  }
  if (!baseUrl) throw new RemakeError("no_url", "record_build needs a url (or serve_dir, or start_command + url).");

  const result: RecordResult = {
    url: baseUrl,
    outDir,
    viewport: vp,
    screenshots: [],
    steps: [],
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
  };
  const browser = await launchBrowser();
  const recordVideo = opts.video !== false;
  try {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.deviceScaleFactor,
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
      colorScheme: opts.colorScheme ?? "light",
      reducedMotion: "no-preference",
    });
    const t0 = Date.now();
    if (opts.showPointer !== false) await context.addInitScript(pointerOverlayScript(vp.mobile ? "touch" : "cursor"));
    const page = await context.newPage();
    const recorder = recordVideo
      ? new ScreencastRecorder(page, rawVideoDir, { width: Math.round(vp.width * vp.deviceScaleFactor), height: Math.round(vp.height * vp.deviceScaleFactor) })
      : null;
    await recorder?.start();
    page.on("console", (m) => {
      if (m.type() === "error" && result.consoleErrors.length < 30) result.consoleErrors.push(m.text().slice(0, 300));
    });
    page.on("pageerror", (e) => {
      if (result.pageErrors.length < 30) result.pageErrors.push(String(e.message).slice(0, 300));
    });
    page.on("requestfailed", (r) => {
      if (result.failedRequests.length < 30) result.failedRequests.push(`${r.failure()?.errorText ?? "failed"} ${r.url()}`.slice(0, 300));
    });
    let mouse = { x: vp.width / 2, y: vp.height * 0.6 };
    const settleMs = opts.settleMs ?? 3000;
    const stepTimeout = opts.stepTimeoutMs ?? 6000;
    let firstPaint = -1;

    const steps = opts.steps[0].action === "goto" ? opts.steps : [{ action: "goto" as const }, ...opts.steps];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const entry = { index: i, action: s.action, time: (Date.now() - t0) / 1000, ok: true } as RecordResult["steps"][number];
      try {
        switch (s.action) {
          case "goto": {
            const target = s.url ? new URL(s.url, baseUrl).toString() : baseUrl;
            await page.goto(target, { waitUntil: "load", timeout: 30_000 });
            await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
            if (firstPaint < 0) firstPaint = (Date.now() - t0) / 1000;
            break;
          }
          case "click":
          case "tap":
          case "hover": {
            let p = point(s, vp);
            const loc = p ? null : locate(page, s);
            if (!p && !loc) throw new Error(`${s.action} needs selector, text, label or x/y`);
            if (loc) {
              await loc.waitFor({ state: "visible", timeout: stepTimeout });
              await loc.scrollIntoViewIfNeeded({ timeout: stepTimeout }).catch(() => {});
              const bb = await loc.boundingBox();
              if (!bb) throw new Error("element has no size on screen");
              p = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
            }
            if (!vp.mobile) {
              await page.mouse.move(p!.x, p!.y, { steps: 14 });
              mouse = p!;
            }
            entry.point = { x: Math.round((p!.x / vp.width) * 1000) / 1000, y: Math.round((p!.y / vp.height) * 1000) / 1000 };
            if (s.action === "hover") break;
            if (vp.mobile) await page.touchscreen.tap(p!.x, p!.y);
            else await page.mouse.click(p!.x, p!.y);
            break;
          }
          case "type": {
            const loc = locate(page, s);
            if (loc) {
              await loc.waitFor({ state: "visible", timeout: stepTimeout });
              if (vp.mobile) {
                const bb = await loc.boundingBox();
                if (bb) await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
              } else await loc.click();
            }
            await page.keyboard.type(s.value ?? "", { delay: 45 });
            break;
          }
          case "press":
            await page.keyboard.press(s.key ?? s.value ?? "Enter");
            break;
          case "scroll": {
            const loc = locate(page, s);
            if (loc) await loc.hover({ timeout: stepTimeout }).catch(() => {});
            else await page.mouse.move(mouse.x, mouse.y);
            const total = s.dy ?? 400;
            const totalX = s.dx ?? 0;
            const n = 10;
            for (let k = 0; k < n; k++) {
              await page.mouse.wheel(totalX / n, total / n);
              await page.waitForTimeout(16);
            }
            break;
          }
          case "wait":
            await page.waitForTimeout(s.ms ?? 1000);
            break;
          case "back":
            await page.goBack({ timeout: stepTimeout }).catch(() => {});
            break;
          case "screenshot":
            break;
          default:
            throw new Error(`Unknown action "${(s as Step).action}"`);
        }
      } catch (e) {
        entry.ok = false;
        entry.error = (e as Error).message.split("\n")[0].slice(0, 240);
      }
      if (s.action !== "wait") await settle(page, settleMs);
      if (s.capture || s.action === "screenshot") {
        const name = (s.capture ?? `step-${i}`).replace(/[^a-z0-9_-]+/gi, "-");
        const file = path.join(shotsDir, `${String(result.screenshots.length + 1).padStart(2, "0")}-${name}.png`);
        await page.evaluate(() => document.documentElement.setAttribute("data-remake-hide", "")).catch(() => {});
        await page.screenshot({ path: file, caret: "hide", animations: "allow", scale: "device" });
        await page.evaluate(() => document.documentElement.removeAttribute("data-remake-hide")).catch(() => {});
        result.screenshots.push({ name: s.capture ?? `step-${i}`, path: file, time: (Date.now() - t0) / 1000, step: i });
      }
      if (s.action !== "wait" && s.action !== "screenshot") await page.waitForTimeout(s.pause ?? 500);
      result.steps.push(entry);
    }
    if (recorder) {
      // The video starts when the first page has loaded (no blank white lead-in).
      const fromWall = t0 / 1000 + Math.max(0, firstPaint);
      const mp4 = path.join(outDir, "build.mp4");
      const rec = await recorder.stop(mp4, { from: fromWall });
      const trim = Math.max(0, firstPaint);
      for (const sh of result.screenshots) sh.time = Math.max(0, Math.round((sh.time - trim) * 1000) / 1000);
      for (const st of result.steps) st.time = Math.max(0, Math.round((st.time - trim) * 1000) / 1000);
      if (rec) {
        result.video = rec.path;
        result.videoDuration = Math.round((await probe(rec.path)).duration * 1000) / 1000;
      }
      if (existsSync(rawVideoDir)) rmSync(rawVideoDir, { recursive: true, force: true });
    }
    await context.close();
  } finally {
    await browser.close().catch(() => {});
    await staticServer?.close();
    await dev?.stop();
  }
  if (!readdirSync(shotsDir).length && !result.video) {
    throw new RemakeError("nothing_recorded", "No screenshots or video were captured.", "Add `capture` names to the steps you want compared.");
  }
  return result;
}
