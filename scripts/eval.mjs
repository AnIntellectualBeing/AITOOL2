#!/usr/bin/env node
/**
 * Optional local eval: runs the FULL Remake loop with a headless agent on the fixture videos
 * and prints match scores. Not run in CI (it uses your agent subscription and takes a while).
 *
 *   npm run build
 *   node scripts/eval.mjs                       # both fixtures, Claude Code (`claude -p`)
 *   node scripts/eval.mjs --only web-app --rounds 2
 *   node scripts/eval.mjs --agent "codex exec --full-auto"   # any CLI that takes the prompt as its last argument
 *
 * Each run happens in eval-runs/<fixture>-<time>/ with the Remake MCP server and skill
 * configured for that folder only. The agent writes remake-report.json; this script then
 * re-runs compare on the agent's final screenshots to check the numbers independently.
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    only: { type: "string" },
    rounds: { type: "string", default: "4" },
    agent: { type: "string", default: "claude" },
    timeout: { type: "string", default: "45" },
  },
});
const cli = path.join(root, "dist", "cli.js");
if (!existsSync(cli)) {
  console.error("Build first: npm run build");
  process.exit(1);
}
const { compare } = await import(path.join(root, "dist", "tools", "compare.js"));
const { watchVideo } = await import(path.join(root, "dist", "tools", "watch.js"));
const { shutdownOcr } = await import(path.join(root, "dist", "core", "ocr.js"));

const fixtures = ["web-app", "phone-app"].filter((f) => !values.only || values.only === f);
const results = [];

for (const name of fixtures) {
  const video = path.join(root, "fixtures", "videos", `${name}.mp4`);
  const dir = path.join(root, "eval-runs", `${name}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  mkdirSync(dir, { recursive: true });
  // Project-scoped MCP config + skill, so nothing global is touched.
  writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { remake: { type: "stdio", command: process.execPath, args: [cli, "mcp"] } } }, null, 2));
  cpSync(path.join(root, "skill"), path.join(dir, ".claude", "skills", "remake"), { recursive: true });
  const prompt = [
    `Remake the app shown in this screen recording: ${video}`,
    "Use the Remake skill and MCP tools. Work only inside the current folder.",
    "I approve the default stack and the default brand replacements in advance: don't stop to ask me, go straight from the spec to building.",
    `Run at most ${values.rounds} check rounds (record_build + compare). Use serve_dir with a static build, or start_command with a dev server.`,
    "Finish by calling make_side_by_side, then write remake-report.json in the current folder with exactly these keys:",
    '{"stack": string, "rounds": number, "overall": number, "screens": [{"id": "s1", "score": number, "pass": boolean}],',
    ' "originalFrames": [{"name": "s1", "path": "..."}], "buildFrames": [{"name": "s1", "path": "..."}], "crop": {"top": number, "bottom": number}, "sideBySide": ["..."], "notes": string}',
    "where buildFrames are the screenshots from your final record_build and originalFrames are watch_video's keyframes.",
  ].join("\n");
  const [cmd, ...baseArgs] = values.agent.split(" ");
  const args =
    cmd === "claude"
      ? ["-p", prompt, "--mcp-config", path.join(dir, ".mcp.json"), "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose", ...baseArgs]
      : [...baseArgs, prompt];
  console.log(`\n▶ ${name}: running ${cmd} in ${path.relative(root, dir)} (log: agent.log)`);
  const started = Date.now();
  const log = createWriteStream(path.join(dir, "agent.log"));
  const code = await new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    const t = setTimeout(() => child.kill("SIGTERM"), Number(values.timeout) * 60_000);
    child.on("close", (c) => {
      clearTimeout(t);
      resolve(c);
    });
  });
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  let cost;
  try {
    const lines = readFileSync(path.join(dir, "agent.log"), "utf8").trim().split("\n");
    const last = JSON.parse(lines.filter((l) => l.startsWith("{")).pop() ?? "{}");
    cost = last.total_cost_usd;
  } catch {
    /* other agents */
  }
  const reportPath = path.join(dir, "remake-report.json");
  if (!existsSync(reportPath)) {
    console.log(`  ✖ no remake-report.json (exit ${code}, ${minutes} min). See ${path.join(dir, "agent.log")}`);
    results.push({ name, ok: false, minutes });
    continue;
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  // Independent check: our own compare on the agent's final screenshots vs the original keyframes.
  let independent = null;
  try {
    const w = await watchVideo(video, { outDir: path.join(dir, ".remake") });
    const original = w.states.map((s) => ({ path: s.keyframe, name: s.id }));
    const build = (report.buildFrames ?? []).filter((f) => existsSync(f.path) && !/visit/.test(f.name));
    if (build.length) independent = await compare({ original, build, crop: w.suggestedCrop, outDir: path.join(dir, "eval-compare") });
  } catch (e) {
    console.log(`  ⚠ independent compare failed: ${e.message}`);
  }
  results.push({ name, ok: true, minutes, cost, report, independent });
  console.log(`  ✔ ${minutes} min${cost ? ` · $${cost.toFixed(2)}` : ""} · stack: ${report.stack} · rounds: ${report.rounds}`);
  console.log(`    agent-reported overall: ${report.overall}`);
  if (independent) {
    console.log(`    independent overall:    ${independent.overall} (${independent.passed}/${independent.total} screens pass)`);
    for (const p of independent.pairs) console.log(`      ${p.name}  ${p.score}  ${p.pass ? "pass" : "FAIL"}  ${JSON.stringify(p.metrics)}`);
  }
  for (const v of report.sideBySide ?? []) console.log(`    side-by-side: ${v}`);
}
await shutdownOcr();
writeFileSync(path.join(root, "eval-runs", "latest.json"), JSON.stringify(results, null, 2));
console.log(`\nSummary written to eval-runs/latest.json`);
