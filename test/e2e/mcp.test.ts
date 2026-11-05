import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixture, ROOT, tmp } from "../helpers.js";

const cli = path.join(ROOT, "dist", "cli.js");

describe.skipIf(!existsSync(cli))("MCP server (stdio)", () => {
  let client: Client;
  const cwd = tmp("remake-mcp-");

  beforeAll(async () => {
    client = new Client({ name: "remake-test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], cwd }));
  });
  afterAll(async () => {
    await client?.close();
  });

  it("lists the six tools and the remake prompt", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["compare", "get_frames", "infer_flow", "make_side_by_side", "record_build", "watch_video"]);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("remake");
    expect(client.getInstructions()).toMatch(/watch_video/);
  });

  it("watch_video returns a summary and contact sheets inline, and writes to ./.remake", async () => {
    const r = (await client.callTool({ name: "watch_video", arguments: { path_or_url: fixture("videos/web-app.mp4"), budget: "low" } }, undefined, { timeout: 240_000 })) as any;
    expect(r.isError).toBeFalsy();
    const summary = JSON.parse(r.content[0].text);
    expect(summary.states.length).toBe(3);
    expect(r.content.some((c: any) => c.type === "image" && c.mimeType === "image/jpeg")).toBe(true);
    expect(existsSync(path.join(cwd, ".remake", ".gitignore"))).toBe(true);
  });

  it("reports problems in plain language", async () => {
    const r = (await client.callTool({ name: "watch_video", arguments: { path_or_url: "/does/not/exist.mp4" } })) as any;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not found/i);
  });
});
