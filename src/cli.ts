#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { describeError } from "./core/errors.js";
import { shutdownOcr } from "./core/ocr.js";
import { skillText, VERSION } from "./meta.js";
import { AGENT_IDS, type AgentId } from "./setup/agents.js";

const HELP = `Remake ${VERSION} — show it a video of any app, get a working copy.

Setup
  npx remake-agents setup [--agents claude,codex,cursor,gemini,opencode] [--all]
                          [--dry-run] [--force] [--yes] [--no-skill] [--npx]
  npx remake-agents uninstall [--dry-run] [--purge]
  npx remake-agents doctor [--fix]

Agent server
  npx remake-agents mcp                 Start the MCP server (stdio). Agents run this for you.

Tools (the same ones your agent calls, handy for debugging)
  watch <video|url> [--budget low|normal|high] [--out DIR] [--no-transcribe] [--force]
  frames <video> <seconds...> [--width N]
  flow <video> [--budget ...]
  record <url> --steps steps.json [--viewport phone|tablet|desktop] [--serve DIR] [--start "npm run dev"]
  compare --original a.png,b.png --build x.png,y.png [--crop-top 0.05] [--threshold 0.85]
  side-by-side <original.mp4> <build.mp4> [--no-watermark] [--gif] [--marks 1.2,3.4 --build-marks 1.0,3.1]
  skill                                  Print the agent skill (playbook).

Docs: https://github.com/AnIntellectualBeing/AITOOL2`;

function list(v: unknown): string[] {
  return typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

function nums(v: unknown): number[] {
  return list(v).map(Number).filter((n) => Number.isFinite(n));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: {
      agents: { type: "string" },
      all: { type: "boolean" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      "no-skill": { type: "boolean" },
      npx: { type: "boolean" },
      purge: { type: "boolean" },
      fix: { type: "boolean" },
      budget: { type: "string" },
      out: { type: "string" },
      "no-transcribe": { type: "boolean" },
      width: { type: "string" },
      steps: { type: "string" },
      viewport: { type: "string" },
      serve: { type: "string" },
      start: { type: "string" },
      original: { type: "string" },
      build: { type: "string" },
      "crop-top": { type: "string" },
      "crop-bottom": { type: "string" },
      threshold: { type: "string" },
      "no-watermark": { type: "boolean" },
      gif: { type: "boolean" },
      marks: { type: "string" },
      "build-marks": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const out = (o: unknown) => console.log(JSON.stringify(o, null, 2));

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    case "--version":
    case "-v":
    case "version":
      console.log(VERSION);
      return;
    case "mcp": {
      const { runServer } = await import("./server.js");
      await runServer();
      return;
    }
    case "setup": {
      const { runSetup } = await import("./setup/index.js");
      const agents = list(values.agents) as AgentId[];
      const bad = agents.filter((a) => !AGENT_IDS.includes(a));
      if (bad.length) throw new Error(`Unknown agent(s): ${bad.join(", ")}. Choose from: ${AGENT_IDS.join(", ")}`);
      await runSetup({
        agents: agents.length ? agents : undefined,
        all: !!values.all,
        dryRun: !!values["dry-run"],
        force: !!values.force,
        yes: !!values.yes,
        skill: !values["no-skill"],
        npx: !!values.npx,
      });
      return;
    }
    case "uninstall": {
      const { runUninstall } = await import("./setup/index.js");
      await runUninstall({ dryRun: !!values["dry-run"], purge: !!values.purge });
      return;
    }
    case "doctor": {
      const { runDoctor } = await import("./setup/index.js");
      const ok = await runDoctor({ fix: !!values.fix });
      process.exitCode = ok ? 0 : 1;
      return;
    }
    case "skill":
      console.log(skillText());
      return;
    case "watch": {
      if (!positionals[0]) throw new Error("Usage: remake-agents watch <video|url>");
      const { watchVideo } = await import("./tools/watch.js");
      const { summariseWatch } = await import("./server.js");
      const r = await watchVideo(positionals[0], {
        budget: (values.budget as "low" | "normal" | "high") ?? "normal",
        outDir: values.out as string | undefined,
        transcribe: !values["no-transcribe"],
        force: !!values.force,
        onProgress: (m) => process.stderr.write(`  ${m}\n`),
      });
      out(values.json ? r : summariseWatch(r));
      return;
    }
    case "frames": {
      const [video, ...ts] = positionals;
      if (!video || !ts.length) throw new Error("Usage: remake-agents frames <video> <seconds...>");
      const { getFrames } = await import("./tools/watch.js");
      out(await getFrames(video, ts.map(Number), { width: values.width ? Number(values.width) : undefined, outDir: values.out as string | undefined }));
      return;
    }
    case "flow": {
      if (!positionals[0]) throw new Error("Usage: remake-agents flow <video>");
      const { inferFlow } = await import("./tools/flow.js");
      out(await inferFlow(positionals[0], { budget: (values.budget as "low" | "normal" | "high") ?? "normal", outDir: values.out as string | undefined }));
      return;
    }
    case "record": {
      if (!values.steps) throw new Error("Usage: remake-agents record <url> --steps steps.json");
      const { recordBuild } = await import("./tools/record.js");
      const steps = JSON.parse(readFileSync(String(values.steps), "utf8"));
      out(
        await recordBuild({
          url: positionals[0],
          steps: Array.isArray(steps) ? steps : steps.steps,
          viewport: (values.viewport as "phone" | "tablet" | "desktop") ?? "desktop",
          serveDir: values.serve as string | undefined,
          startCommand: values.start as string | undefined,
          outDir: values.out as string | undefined,
        }),
      );
      return;
    }
    case "compare": {
      const { compare } = await import("./tools/compare.js");
      const crop = values["crop-top"] || values["crop-bottom"] ? { top: Number(values["crop-top"] ?? 0), bottom: Number(values["crop-bottom"] ?? 0) } : undefined;
      out(
        await compare({
          original: list(values.original),
          build: list(values.build),
          crop,
          threshold: values.threshold ? Number(values.threshold) : undefined,
          outDir: values.out as string | undefined,
        }),
      );
      return;
    }
    case "side-by-side": {
      const [original, build] = positionals;
      if (!original || !build) throw new Error("Usage: remake-agents side-by-side <original.mp4> <build.mp4>");
      const { makeSideBySide } = await import("./tools/sideBySide.js");
      out(
        await makeSideBySide({
          original,
          build,
          watermark: !values["no-watermark"],
          gif: !!values.gif,
          originalMarks: nums(values.marks),
          buildMarks: nums(values["build-marks"]),
          outDir: values.out as string | undefined,
        }),
      );
      return;
    }
    default:
      console.error(`Unknown command "${cmd}".\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main()
  .then(async () => {
    if (process.argv[2] !== "mcp") await shutdownOcr();
  })
  .catch(async (e) => {
    console.error(`\n✖ ${describeError(e)}`);
    await shutdownOcr();
    process.exitCode = 1;
  });
