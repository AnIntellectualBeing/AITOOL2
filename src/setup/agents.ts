import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { which } from "../core/exec.js";
import { remakeHome } from "../core/paths.js";
import { PACKAGE_ROOT, SKILL_DIR, VERSION } from "../meta.js";

export type AgentId = "claude" | "codex" | "cursor" | "gemini" | "opencode";
export const AGENT_IDS: AgentId[] = ["claude", "codex", "cursor", "gemini", "opencode"];

export interface ServerCommand {
  command: string;
  args: string[];
}

export interface AgentDef {
  id: AgentId;
  name: string;
  bins: string[];
  configDir: string;
  mcp: { kind: "json"; file: string; keyPath: string[]; value: (c: ServerCommand) => unknown; newFile?: Record<string, unknown> } | { kind: "toml"; file: string };
  skillsDir: string;
}

export interface Change {
  agent: AgentId;
  agentName: string;
  action: "added" | "updated" | "unchanged" | "removed" | "skipped" | "would-add" | "would-remove";
  what: string;
  file: string;
  detail?: string;
}

const SERVER_NAME = "remake";
const MARK_START = "# >>> remake-agents (managed by `npx remake-agents setup`; remove with `npx remake-agents uninstall`) >>>";
const MARK_END = "# <<< remake-agents <<<";
const SKILL_MARKER = ".remake-agents.json";

export function agentDefs(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): AgentDef[] {
  const claudeDir = env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
  const claudeJson = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(home, ".claude.json");
  const codexDir = env.CODEX_HOME ?? path.join(home, ".codex");
  const xdg = env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  const ocDir = path.join(xdg, "opencode");
  const ocFile = existsSync(path.join(ocDir, "opencode.jsonc")) ? path.join(ocDir, "opencode.jsonc") : path.join(ocDir, "opencode.json");
  return [
    {
      id: "claude",
      name: "Claude Code",
      bins: ["claude"],
      configDir: claudeDir,
      mcp: { kind: "json", file: claudeJson, keyPath: ["mcpServers", SERVER_NAME], value: (c) => ({ type: "stdio", command: c.command, args: c.args, env: {} }) },
      skillsDir: path.join(claudeDir, "skills"),
    },
    {
      id: "codex",
      name: "Codex",
      bins: ["codex"],
      configDir: codexDir,
      mcp: { kind: "toml", file: path.join(codexDir, "config.toml") },
      skillsDir: path.join(codexDir, "skills"),
    },
    {
      id: "cursor",
      name: "Cursor",
      bins: ["cursor", "cursor-agent"],
      configDir: path.join(home, ".cursor"),
      mcp: { kind: "json", file: path.join(home, ".cursor", "mcp.json"), keyPath: ["mcpServers", SERVER_NAME], value: (c) => ({ command: c.command, args: c.args }) },
      skillsDir: path.join(home, ".cursor", "skills"),
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      bins: ["gemini"],
      configDir: path.join(home, ".gemini"),
      mcp: {
        kind: "json",
        file: path.join(home, ".gemini", "settings.json"),
        keyPath: ["mcpServers", SERVER_NAME],
        value: (c) => ({ command: c.command, args: c.args, timeout: 900_000 }),
      },
      skillsDir: path.join(home, ".gemini", "skills"),
    },
    {
      id: "opencode",
      name: "OpenCode",
      bins: ["opencode"],
      configDir: ocDir,
      mcp: {
        kind: "json",
        file: ocFile,
        keyPath: ["mcp", SERVER_NAME],
        value: (c) => ({ type: "local", command: [c.command, ...c.args], enabled: true }),
        newFile: { $schema: "https://opencode.ai/config.json" },
      },
      skillsDir: path.join(ocDir, "skills"),
    },
  ];
}

export function detectAgent(a: AgentDef): { found: boolean; why: string } {
  const bin = a.bins.map((b) => which(b)).find(Boolean);
  if (bin) return { found: true, why: `found ${path.basename(bin)} on PATH` };
  if (existsSync(a.configDir)) return { found: true, why: `found ${tilde(a.configDir)}` };
  return { found: false, why: "not installed" };
}

/** Is this copy running from npx's temporary cache (e.g. `npx remake-agents setup`)? */
export function runningFromNpxCache(): boolean {
  return /[\\/]_npx[\\/]/.test(PACKAGE_ROOT);
}

/**
 * Copy the running package (and its installed dependencies) out of the npx cache into
 * ~/.remake/app/<version>, so agents start a stable local copy: no network on start-up,
 * and npm cache cleaning can't break it. Returns the CLI path inside the copy.
 */
export function pinStableCopy(): string {
  // PACKAGE_ROOT = …/_npx/<hash>/node_modules/remake-agents → copy …/_npx/<hash>
  const nm = path.dirname(PACKAGE_ROOT);
  const treeRoot = path.basename(nm) === "node_modules" ? path.dirname(nm) : PACKAGE_ROOT;
  const dest = path.join(remakeHome(), "app", VERSION);
  const cli = path.join(dest, path.relative(treeRoot, PACKAGE_ROOT), "dist", "cli.js");
  if (!existsSync(cli)) {
    mkdirSync(dest, { recursive: true });
    cpSync(treeRoot, dest, { recursive: true, dereference: true });
  }
  return cli;
}

/** How agents should start the MCP server. */
export function serverCommand(opts: { npx?: boolean; cliPath?: string } = {}): ServerCommand {
  if (opts.npx) {
    if (process.platform === "win32") return { command: "cmd", args: ["/c", "npx", "-y", "remake-agents@latest", "mcp"] };
    return { command: "npx", args: ["-y", "remake-agents@latest", "mcp"] };
  }
  // Use this exact Node + CLI (works even when GUI apps like Cursor start with a minimal PATH).
  return { command: process.execPath, args: [opts.cliPath ?? path.join(PACKAGE_ROOT, "dist", "cli.js"), "mcp"] };
}

export function tilde(p: string): string {
  const h = os.homedir();
  return p.startsWith(h) ? "~" + p.slice(h.length) : p;
}

function isOurs(v: unknown): boolean {
  const s = JSON.stringify(v ?? "").replace(/\\\\/g, "/");
  return s.includes("remake-agents") || s.includes("/.remake/app/") || s.includes(path.join(PACKAGE_ROOT, "dist", "cli.js").replace(/\\/g, "/"));
}

function backup(file: string): void {
  if (!existsSync(file)) return;
  const dir = path.join(remakeHome(), "backups", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
  mkdirSync(dir, { recursive: true });
  copyFileSync(file, path.join(dir, path.basename(path.dirname(file)) + "__" + path.basename(file)));
}

function readJsonc(file: string): { text: string; value: any } {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const errors: ParseError[] = [];
  const value = text.trim() ? parse(text, errors, { allowTrailingComma: true }) : {};
  if (errors.length && text.trim()) throw new Error(`${tilde(file)} isn't valid JSON (left untouched). Fix it and run setup again.`);
  return { text: text.trim() ? text : "{}\n", value: value ?? {} };
}

function getPath(obj: any, keys: string[]): unknown {
  return keys.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } };

export function installMcp(a: AgentDef, cmd: ServerCommand, opts: { dryRun?: boolean; force?: boolean } = {}): Change {
  const base = { agent: a.id, agentName: a.name, file: a.mcp.file, what: "MCP server \"remake\"" };
  if (a.mcp.kind === "json") {
    const { text, value } = readJsonc(a.mcp.file);
    const current = getPath(value, a.mcp.keyPath);
    const next = a.mcp.value(cmd);
    if (current !== undefined && !isOurs(current) && !opts.force) {
      return { ...base, action: "skipped", detail: `a different "${SERVER_NAME}" server is already configured (use --force to replace it)` };
    }
    if (JSON.stringify(current) === JSON.stringify(next)) return { ...base, action: "unchanged", detail: `${a.mcp.keyPath.join(".")} already set` };
    if (opts.dryRun) return { ...base, action: "would-add", detail: `set ${a.mcp.keyPath.join(".")}` };
    let out = text;
    if (!existsSync(a.mcp.file) && a.mcp.newFile) for (const [k, v] of Object.entries(a.mcp.newFile)) out = applyEdits(out, modify(out, [k], v, fmt));
    out = applyEdits(out, modify(out, a.mcp.keyPath, next, fmt));
    backup(a.mcp.file);
    mkdirSync(path.dirname(a.mcp.file), { recursive: true });
    writeFileSync(a.mcp.file, out.endsWith("\n") ? out : out + "\n");
    return { ...base, action: current === undefined ? "added" : "updated", detail: `${current === undefined ? "added" : "updated"} ${a.mcp.keyPath.join(".")}` };
  }
  // TOML (Codex): a clearly marked block we can find and remove later.
  const file = a.mcp.file;
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const block = [
    MARK_START,
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(cmd.command)}`,
    `args = [${cmd.args.map((x) => JSON.stringify(x)).join(", ")}]`,
    "startup_timeout_sec = 60",
    "tool_timeout_sec = 900",
    MARK_END,
  ].join("\n");
  const hasOurs = text.includes(MARK_START);
  const stripped = removeTomlBlock(text);
  if (!hasOurs && new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_NAME}\\]`, "m").test(text) && !opts.force) {
    return { ...base, action: "skipped", detail: `[mcp_servers.${SERVER_NAME}] already exists in config.toml` };
  }
  const next = (stripped.trimEnd() ? stripped.trimEnd() + "\n\n" : "") + block + "\n";
  if (next === text) return { ...base, action: "unchanged", detail: `[mcp_servers.${SERVER_NAME}] already set` };
  if (opts.dryRun) return { ...base, action: "would-add", detail: `add [mcp_servers.${SERVER_NAME}] block` };
  backup(file);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, next);
  return { ...base, action: hasOurs ? "updated" : "added", detail: `${hasOurs ? "updated" : "added"} [mcp_servers.${SERVER_NAME}] block` };
}

export function removeTomlBlock(text: string): string {
  const s = text.indexOf(MARK_START);
  if (s < 0) return text;
  const e = text.indexOf(MARK_END, s);
  if (e < 0) return text;
  return (text.slice(0, s).replace(/\n+$/, "\n") + text.slice(e + MARK_END.length).replace(/^\n+/, "\n")).replace(/^\n+/, "");
}

export function uninstallMcp(a: AgentDef, opts: { dryRun?: boolean } = {}): Change | null {
  const base = { agent: a.id, agentName: a.name, file: a.mcp.file, what: "MCP server \"remake\"" };
  if (!existsSync(a.mcp.file)) return null;
  if (a.mcp.kind === "json") {
    let parsed;
    try {
      parsed = readJsonc(a.mcp.file);
    } catch {
      return { ...base, action: "skipped", detail: "file isn't valid JSON; left untouched" };
    }
    const current = getPath(parsed.value, a.mcp.keyPath);
    if (current === undefined) return null;
    if (!isOurs(current)) return { ...base, action: "skipped", detail: `"${SERVER_NAME}" there wasn't added by Remake; left untouched` };
    if (opts.dryRun) return { ...base, action: "would-remove", detail: `remove ${a.mcp.keyPath.join(".")}` };
    backup(a.mcp.file);
    let out = applyEdits(parsed.text, modify(parsed.text, a.mcp.keyPath, undefined, fmt));
    // Drop an now-empty parent object we may have created.
    const parentPath = a.mcp.keyPath.slice(0, -1);
    const parent = getPath(parse(out), parentPath);
    if (parent && typeof parent === "object" && Object.keys(parent).length === 0) out = applyEdits(out, modify(out, parentPath, undefined, fmt));
    writeFileSync(a.mcp.file, out);
    return { ...base, action: "removed", detail: `removed ${a.mcp.keyPath.join(".")}` };
  }
  const text = readFileSync(a.mcp.file, "utf8");
  if (!text.includes(MARK_START)) return null;
  if (opts.dryRun) return { ...base, action: "would-remove", detail: `remove [mcp_servers.${SERVER_NAME}] block` };
  backup(a.mcp.file);
  writeFileSync(a.mcp.file, removeTomlBlock(text));
  return { ...base, action: "removed", detail: `removed [mcp_servers.${SERVER_NAME}] block` };
}

function listFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else out.push(r);
  }
  return out;
}

export function installSkill(a: AgentDef, opts: { dryRun?: boolean; force?: boolean } = {}): Change {
  const dest = path.join(a.skillsDir, SERVER_NAME);
  const base = { agent: a.id, agentName: a.name, file: dest + path.sep, what: "skill \"remake\"" };
  const marker = path.join(dest, SKILL_MARKER);
  if (existsSync(dest) && !existsSync(marker) && !opts.force) {
    return { ...base, action: "skipped", detail: "a different skill named remake already exists (use --force to replace it)" };
  }
  const files = listFiles(SKILL_DIR);
  const same =
    existsSync(marker) &&
    files.every((f) => existsSync(path.join(dest, f)) && readFileSync(path.join(dest, f), "utf8") === readFileSync(path.join(SKILL_DIR, f), "utf8"));
  if (same) return { ...base, action: "unchanged", detail: "skill is up to date" };
  if (opts.dryRun) return { ...base, action: "would-add", detail: `copy ${files.length} files` };
  const existed = existsSync(dest);
  if (existed) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(SKILL_DIR, dest, { recursive: true });
  writeFileSync(marker, JSON.stringify({ installedBy: "remake-agents", version: VERSION }, null, 2) + "\n");
  return { ...base, action: existed ? "updated" : "added", detail: `${existed ? "updated" : "installed"} ${files.length} files` };
}

export function uninstallSkill(a: AgentDef, opts: { dryRun?: boolean } = {}): Change | null {
  const dest = path.join(a.skillsDir, SERVER_NAME);
  if (!existsSync(dest)) return null;
  const base = { agent: a.id, agentName: a.name, file: dest + path.sep, what: "skill \"remake\"" };
  if (!existsSync(path.join(dest, SKILL_MARKER))) return { ...base, action: "skipped", detail: "not installed by Remake; left untouched" };
  if (opts.dryRun) return { ...base, action: "would-remove", detail: "delete folder" };
  rmSync(dest, { recursive: true, force: true });
  return { ...base, action: "removed", detail: "deleted folder" };
}
