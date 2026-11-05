# Contributing to Remake

Thanks for helping! Remake has two halves:

- **Deterministic tools** (`src/tools`, `src/core`): video analysis, flow inference, recording, comparison, video output. These must be testable and give the same result every time.
- **The skill** (`skill/SKILL.md`): the playbook the agent follows. Changes here are judged with the eval script, not unit tests.

## Setup

```bash
npm install
npx playwright-core install chromium   # or have Chrome / Edge installed
npm run build
npm test
```

You need Node 20+ and ffmpeg on your PATH (or run `node dist/cli.js doctor --fix`).

## Layout

| Path | What |
|---|---|
| `src/core/ffmpeg.ts` | finding/downloading ffmpeg, probing, frame sampling (with `scdet` scene scores), frame extraction |
| `src/core/motion.ts` | timeline segmentation, animation classification (fade / slide / scroll / cover / reveal), easing fit |
| `src/core/image.ts` | pHash, SSIM, diffs, connected components, colour maths |
| `src/core/design.ts` | layout boxes, palette + roles, type scale, spacing |
| `src/core/ocr.ts` | Tesseract OCR (plus a pass for light text on filled buttons) |
| `src/tools/*` | the six MCP tools |
| `src/server.ts` | MCP server (stdio), tool schemas, the `remake` prompt |
| `src/setup/*` | `setup` / `uninstall` / `doctor` for the five agents |
| `fixtures/apps/*` | the two sample apps (with a `?broken=1` variant) |
| `fixtures/videos/*` | test recordings + `*.truth.json` (when each action happened and where) |
| `test/unit`, `test/e2e` | Vitest suites; e2e runs the whole pipeline on the fixtures |
| `scripts/eval.mjs` | optional full-loop eval with a headless agent |

## Guidelines

- **Plain-language errors.** Throw `RemakeError(code, message, hint)` with what went wrong and what to do about it.
- **Token budget.** Anything returned to the agent counts. Keep text compact, put full detail in the JSON files under `.remake/`, and prefer contact sheets to single frames.
- **Cross-platform.** No shell strings with paths (use argument arrays), no POSIX-only tools, and no hard-coded `/`.
- **Tests.** New analysis behaviour needs a unit test with synthetic frames and, where it matters, an e2e assertion against the fixture truth files. If you change a fixture app, re-record with `npm run fixtures` and commit the new videos and truth files.
- **Skill changes.** Run `node scripts/eval.mjs` before and after, and put the numbers in the PR.
- **Respect IP.** Fixtures and examples must be original. Don't add recordings of real products.

## Releasing

`npm version <patch|minor>` then `npm publish`. `prepublishOnly` builds. The package name is `remake-agents`.
