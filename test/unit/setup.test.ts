import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentDefs, installMcp, installSkill, removeTomlBlock, uninstallMcp, uninstallSkill } from "../../src/setup/agents.js";
import { tmp } from "../helpers.js";

const cmd = { command: "npx", args: ["-y", "remake-agents@latest", "mcp"] };

function fakeHome() {
  const home = tmp("remake-home-");
  const env = { REMAKE_HOME: path.join(home, ".remake") } as NodeJS.ProcessEnv;
  process.env.REMAKE_HOME = env.REMAKE_HOME;
  return { home, defs: agentDefs(home, env) };
}

describe("setup / uninstall", () => {
  it("adds and removes the server for every agent, leaving other settings intact", () => {
    const { home, defs } = fakeHome();
    mkdirSync(path.join(home, ".gemini"), { recursive: true });
    const geminiOriginal = '{\n  // my settings\n  "theme": "dark",\n  "mcpServers": { "other": { "command": "x" } }\n}\n';
    writeFileSync(path.join(home, ".gemini", "settings.json"), geminiOriginal);
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    const codexOriginal = 'model = "o4"\n\n[mcp_servers.other]\ncommand = "x"\n';
    writeFileSync(path.join(home, ".codex", "config.toml"), codexOriginal);

    for (const d of defs) {
      expect(["added", "updated"]).toContain(installMcp(d, cmd).action);
      expect(installMcp(d, cmd).action).toBe("unchanged");
      expect(installSkill(d).action).toBe("added");
      expect(existsSync(path.join(d.skillsDir, "remake", "SKILL.md"))).toBe(true);
    }
    const gem = readFileSync(path.join(home, ".gemini", "settings.json"), "utf8");
    expect(gem).toContain("// my settings");
    expect(gem).toContain('"other"');
    expect(gem).toContain("remake-agents@latest");
    const codex = readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    expect(codex).toContain("[mcp_servers.remake]");
    expect(codex).toContain("[mcp_servers.other]");
    const oc = JSON.parse(readFileSync(path.join(home, ".config", "opencode", "opencode.json"), "utf8"));
    expect(oc.mcp.remake.command).toEqual(["npx", "-y", "remake-agents@latest", "mcp"]);
    const claude = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"));
    expect(claude.mcpServers.remake.type).toBe("stdio");

    for (const d of defs) {
      expect(uninstallMcp(d)?.action).toBe("removed");
      expect(uninstallSkill(d)?.action).toBe("removed");
    }
    expect(readFileSync(path.join(home, ".codex", "config.toml"), "utf8").trim()).toBe(codexOriginal.trim());
    const gemAfter = readFileSync(path.join(home, ".gemini", "settings.json"), "utf8");
    expect(gemAfter).toContain("// my settings");
    expect(gemAfter).not.toContain("remake");
  });

  it("never overwrites a server or skill named remake that it didn't create", () => {
    const { home, defs } = fakeHome();
    const cursor = defs.find((d) => d.id === "cursor")!;
    mkdirSync(path.join(home, ".cursor", "skills", "remake"), { recursive: true });
    writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { remake: { command: "something-else" } } }));
    writeFileSync(path.join(home, ".cursor", "skills", "remake", "SKILL.md"), "mine");
    expect(installMcp(cursor, cmd).action).toBe("skipped");
    expect(installSkill(cursor).action).toBe("skipped");
    expect(uninstallMcp(cursor)?.action).toBe("skipped");
    expect(uninstallSkill(cursor)?.action).toBe("skipped");
    expect(readFileSync(path.join(home, ".cursor", "skills", "remake", "SKILL.md"), "utf8")).toBe("mine");
  });

  it("dry run changes nothing", () => {
    const { home, defs } = fakeHome();
    for (const d of defs) {
      expect(installMcp(d, cmd, { dryRun: true }).action).toBe("would-add");
      expect(installSkill(d, { dryRun: true }).action).toBe("would-add");
    }
    expect(existsSync(path.join(home, ".claude.json"))).toBe(false);
    expect(existsSync(path.join(home, ".codex"))).toBe(false);
  });

  it("removes only the marked TOML block", () => {
    const t = 'a = 1\n\n# >>> remake-agents (managed by `npx remake-agents setup`; remove with `npx remake-agents uninstall`) >>>\n[mcp_servers.remake]\n# <<< remake-agents <<<\n\n[b]\nc = 2\n';
    expect(removeTomlBlock(t)).toBe("a = 1\n\n[b]\nc = 2\n");
  });
});
