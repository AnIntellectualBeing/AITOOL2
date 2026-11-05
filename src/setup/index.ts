import { existsSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { installChromium, launchBrowser } from "../core/browser.js";
import { describeError } from "../core/errors.js";
import { which } from "../core/exec.js";
import { findTools, installPrivateFfmpeg, ffmpegInstallHelp } from "../core/ffmpeg.js";
import { ensureDir, remakeHome } from "../core/paths.js";
import { VERSION } from "../meta.js";
import {
  AGENT_IDS,
  agentDefs,
  detectAgent,
  installMcp,
  installSkill,
  serverCommand,
  tilde,
  uninstallMcp,
  uninstallSkill,
  type AgentId,
  type Change,
} from "./agents.js";

export interface SetupOptions {
  agents?: AgentId[];
  all?: boolean;
  dryRun?: boolean;
  force?: boolean;
  yes?: boolean;
  skill?: boolean;
  npx?: boolean;
  checkDeps?: boolean;
  home?: string;
  log?: (s: string) => void;
}

const ICON: Record<Change["action"], string> = {
  added: "✔",
  updated: "✔",
  unchanged: "•",
  removed: "✔",
  skipped: "⚠",
  "would-add": "→",
  "would-remove": "→",
};

function printChanges(changes: Change[], log: (s: string) => void) {
  for (const c of changes) log(`  ${ICON[c.action]} ${c.agentName.padEnd(12)} ${c.what.padEnd(22)} ${tilde(c.file)}${c.detail ? `  (${c.detail})` : ""}`);
}

async function ask(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q} [Y/n] `)).trim().toLowerCase();
  rl.close();
  return a === "" || a === "y" || a === "yes";
}

function manifestPath() {
  return path.join(remakeHome(), "install-manifest.json");
}

export async function runSetup(opts: SetupOptions = {}): Promise<{ changes: Change[]; configured: AgentId[] }> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const defs = agentDefs(opts.home);
  log(`Remake ${VERSION} setup${opts.dryRun ? " (dry run: nothing will be changed)" : ""}\n`);
  const selected = defs.filter((d) => {
    if (opts.agents?.length) return opts.agents.includes(d.id);
    if (opts.all) return true;
    return detectAgent(d).found;
  });
  log("Agents:");
  for (const d of defs) {
    const det = detectAgent(d);
    const on = selected.includes(d);
    log(`  ${on ? "●" : "○"} ${d.name.padEnd(12)} ${on ? (det.found ? det.why : "selected with --agents") : det.why}`);
  }
  if (!selected.length) {
    log("\nNo supported agent found. Pick one explicitly, e.g. `npx remake-agents setup --agents claude`.");
    log(`Supported: ${AGENT_IDS.join(", ")}`);
    return { changes: [], configured: [] };
  }
  const cmd = serverCommand({ npx: opts.npx });
  log(`\nMCP server command: ${[cmd.command, ...cmd.args].join(" ")}\n`);
  const changes: Change[] = [];
  const claudeSkill = selected.some((d) => d.id === "claude") && opts.skill !== false;
  for (const d of selected) {
    try {
      changes.push(installMcp(d, cmd, opts));
    } catch (e) {
      changes.push({ agent: d.id, agentName: d.name, action: "skipped", what: "MCP server \"remake\"", file: d.mcp.file, detail: describeError(e) });
    }
    if (opts.skill === false) continue;
    if (d.id === "opencode" && claudeSkill) {
      changes.push({ agent: d.id, agentName: d.name, action: "unchanged", what: "skill \"remake\"", file: path.join(d.skillsDir, "remake"), detail: "OpenCode also reads ~/.claude/skills, so it uses the Claude Code copy" });
      continue;
    }
    try {
      changes.push(installSkill(d, opts));
    } catch (e) {
      changes.push({ agent: d.id, agentName: d.name, action: "skipped", what: "skill \"remake\"", file: d.skillsDir, detail: describeError(e) });
    }
  }
  log(opts.dryRun ? "Would change:" : "Changes:");
  printChanges(changes, log);
  if (!opts.dryRun) {
    ensureDir(remakeHome());
    let prev: { changes: Change[] } = { changes: [] };
    try {
      prev = JSON.parse(readFileSync(manifestPath(), "utf8"));
    } catch {
      /* first install */
    }
    const kept = prev.changes.filter((c) => !changes.some((n) => n.agent === c.agent && n.what === c.what));
    writeFileSync(
      manifestPath(),
      JSON.stringify({ version: VERSION, updatedAt: new Date().toISOString(), command: cmd, changes: [...kept, ...changes.filter((c) => c.action === "added" || c.action === "updated" || c.action === "unchanged")] }, null, 2),
    );
    log(`\nBackups of every edited file are in ${tilde(path.join(remakeHome(), "backups"))}. Undo everything with: npx remake-agents uninstall`);
  }

  if (opts.checkDeps !== false) {
    log("\nChecking tools:");
    try {
      const t = findTools();
      log(`  ✔ ffmpeg      ${tilde(t.ffmpeg)}`);
    } catch {
      log("  ⚠ ffmpeg      not found");
      if (!opts.dryRun && (opts.yes || (await ask("  Download a private copy of ffmpeg into ~/.remake/tools (~80 MB)?")))) {
        try {
          const t = await installPrivateFfmpeg((s) => log(`    ${s}`));
          log(`  ✔ ffmpeg      ${tilde(t.ffmpeg)}`);
        } catch (e) {
          log(`  ✖ ${describeError(e)}`);
        }
      } else log(ffmpegInstallHelp().split("\n").map((l) => `    ${l}`).join("\n"));
    }
    try {
      const b = await launchBrowser();
      log(`  ✔ browser     Chromium ${b.version()}`);
      await b.close();
    } catch {
      log("  ⚠ browser     no Chromium/Chrome/Edge found (needed by record_build)");
      if (!opts.dryRun && (opts.yes || (await ask("  Download Chromium for Playwright (~150 MB)?")))) {
        try {
          await installChromium((s) => log(`    ${s}`));
          log("  ✔ browser     installed");
        } catch (e) {
          log(`  ✖ ${describeError(e)}`);
        }
      } else log("    Install Google Chrome, or run: npx remake-agents doctor --fix");
    }
    log(`  ${which("yt-dlp") ? "✔" : "•"} yt-dlp      ${which("yt-dlp") ? "found" : "optional — only needed for YouTube/Loom links"}`);
  }
  if (!opts.dryRun) {
    log(`\nDone. Restart your agent, then try:\n  "Remake the app in ~/Desktop/recording.mp4"`);
    if (selected.some((d) => d.id === "claude")) log(`  (Claude Code: the skill loads automatically; /mcp should list "remake")`);
  }
  return { changes, configured: selected.map((d) => d.id) };
}

export async function runUninstall(opts: { dryRun?: boolean; home?: string; log?: (s: string) => void; purge?: boolean } = {}): Promise<Change[]> {
  const log = opts.log ?? ((s: string) => console.log(s));
  log(`Remake ${VERSION} uninstall${opts.dryRun ? " (dry run)" : ""}\n`);
  const changes: Change[] = [];
  for (const d of agentDefs(opts.home)) {
    const m = uninstallMcp(d, opts);
    if (m) changes.push(m);
    const s = uninstallSkill(d, opts);
    if (s) changes.push(s);
  }
  if (!changes.length) log("Nothing to remove: Remake isn't configured in any agent.");
  else printChanges(changes, log);
  if (!opts.dryRun) {
    if (existsSync(manifestPath())) rmSync(manifestPath());
    if (opts.purge && existsSync(remakeHome())) {
      rmSync(remakeHome(), { recursive: true, force: true });
      log(`  ✔ deleted ${tilde(remakeHome())} (downloaded tools, caches, backups)`);
    } else if (existsSync(remakeHome())) log(`\n${tilde(remakeHome())} (downloaded tools, caches, backups) was kept. Delete it with --purge.`);
    log("Project folders may still contain a .remake/ directory with analysis output; it's safe to delete.");
  }
  return changes;
}

export async function runDoctor(opts: { fix?: boolean; log?: (s: string) => void } = {}): Promise<boolean> {
  const log = opts.log ?? ((s: string) => console.log(s));
  let ok = true;
  log(`Remake ${VERSION} doctor\n`);
  const major = Number(process.versions.node.split(".")[0]);
  log(`  ${major >= 20 ? "✔" : "✖"} Node.js     ${process.versions.node}${major >= 20 ? "" : " (Remake needs Node 20 or newer)"}`);
  if (major < 20) ok = false;
  try {
    const t = findTools();
    log(`  ✔ ffmpeg      ${tilde(t.ffmpeg)} (${t.source})`);
  } catch {
    if (opts.fix) {
      try {
        const t = await installPrivateFfmpeg((s) => log(`    ${s}`));
        log(`  ✔ ffmpeg      ${tilde(t.ffmpeg)} (downloaded)`);
      } catch (e) {
        ok = false;
        log(`  ✖ ffmpeg      ${describeError(e)}`);
      }
    } else {
      ok = false;
      log(`  ✖ ffmpeg      missing\n${ffmpegInstallHelp().split("\n").map((l) => `      ${l}`).join("\n")}`);
    }
  }
  try {
    const b = await launchBrowser();
    log(`  ✔ browser     Chromium ${b.version()}`);
    await b.close();
  } catch (e) {
    if (opts.fix) {
      try {
        await installChromium((s) => log(`    ${s}`));
        log("  ✔ browser     installed Playwright Chromium");
      } catch (e2) {
        ok = false;
        log(`  ✖ browser     ${describeError(e2)}`);
      }
    } else {
      ok = false;
      log(`  ✖ browser     ${describeError(e).split("\n")[0]} — run with --fix, or install Chrome`);
    }
  }
  log(`  ${which("yt-dlp") ? "✔" : "•"} yt-dlp      ${which("yt-dlp") ?? "not installed (optional, for links)"}`);
  const whisper = which("whisper-cli") ?? which("whisper-cpp") ?? which("whisper-ctranslate2") ?? which("whisper");
  log(`  ${whisper ? "✔" : "•"} whisper     ${whisper ?? "not installed (optional, transcribes narration)"}`);
  log("\nAgents:");
  for (const d of agentDefs()) {
    let configured = false;
    try {
      configured = existsSync(d.mcp.file) && readFileSync(d.mcp.file, "utf8").includes("remake");
    } catch {
      /* ignore */
    }
    const det = detectAgent(d);
    log(`  ${configured ? "✔" : det.found ? "○" : " "} ${d.name.padEnd(12)} ${configured ? `configured (${tilde(d.mcp.file)})` : det.found ? "installed, not configured — run setup" : "not installed"}`);
  }
  log(`\nPlatform: ${os.platform()} ${os.arch()}`);
  return ok;
}
