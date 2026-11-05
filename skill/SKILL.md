---
name: remake
description: Rebuild a working app from a screen recording (phone app, desktop app or website; MP4 file or YouTube/Loom link). Use when the user shares a recording/video of an app and wants a working copy, clone, prototype or remake of it. Watches the video with the Remake MCP tools, writes a spec, builds the app screen by screen, records the build and compares it to the original until they match, then makes a side-by-side video.
---

# Remake: video of an app → working copy

You have the **Remake** MCP tools: `watch_video`, `get_frames`, `infer_flow`, `record_build`, `compare`, `make_side_by_side`.
The tools are deterministic: they measure. **You** do the thinking: read the frames, write the spec, write the code, decide what to fix.

Remake is for prototyping, learning and rebuilding your own designs. Respect copyrights and trademarks.

## 0. Ground rules

- **Brand safety (default ON).** Replace logos, brand names, product names and trademarked icons with neutral placeholders: a generic name such as "Acme" or "Notes", a simple geometric logo, and open icons such as Lucide. Tell the user you did this, in the spec and in the final summary. Skip it only if the user says the design is theirs and asks you to keep the branding.
- **Don't copy proprietary assets.** No downloading their images, fonts or icon files from the app. Use system fonts or close open fonts, and placeholder images.
- **Videos stay local.** Don't upload the recording anywhere. Read frames only through the tools.
- **Be honest.** Report the real scores. Never claim a screen matches if `compare` says it doesn't.

## 1. Watch

1. Call `watch_video(path_or_url, budget="normal")`. Use `low` for long or simple recordings and `high` only if detail is missing.
2. Look at every contact sheet it returns. Each cell is a distinct UI state (`s1`, `s2`, …), labelled with its timestamp. The `transitions` sheet shows animations at their start, middle and end.
3. Call `infer_flow(path)`. It returns the navigation graph, what was tapped or clicked for each transition, a mermaid diagram, and `replaySteps` for checking later.
4. If anything is unclear (small text, a fast animation, an icon), call `get_frames(path, [t1, t2, …])` to zoom into exact moments. Don't guess when you can look.

Token tips: contact sheets are cheap. Individual full-size frames are expensive, so ask only for the moments you need. The full analysis JSON is on disk (`analysisFile`) if you need to re-read numbers.

## 2. Spec, then confirm

Write `REMAKE_SPEC.md` in the project using the template in `spec-template.md` (next to this file). It covers:

- **Screens**: one section per state id, with purpose, layout from top to bottom, components, and all visible text (copy it from the OCR `text`, fixing obvious OCR mistakes).
- **Navigation flow**: the mermaid diagram from `infer_flow`, plus the trigger for each edge.
- **States**: toggles, selected tabs, empty/filled, open sheets.
- **Animations**: for each transition, kind, duration (ms) and easing from `animations`. Map them to code (CSS transitions, Framer Motion, Reanimated/Animated).
- **Design tokens**: colour roles from `palette.roles`, the type scale (px) from `typeScale`, the spacing base unit and common gaps from `spacing`, and radii/shadows estimated from the frames.
- **Data**: the realistic mock data you will use, matching the counts and kinds shown in the video.
- **Brand replacements**: a table of original → placeholder.
- **Out of scope**: real backends, auth and payments are mocked.

Then **show the user a short summary of the spec and confirm the stack**:

- Web recording (`platform: desktop`) → default **React + Vite + Tailwind**.
- Phone recording (`platform: phone`) → default **Expo (React Native)**, runnable on web for checking (`npx expo start --web`, or `npx expo export -p web` then serve `dist/`).
- Tablet: pick based on whether it looks like a web app or a native app.

Wait for the user's go-ahead, or for a different stack, before building. If the user already said "just build it", go ahead with the defaults.

## 3. Build screen by screen

- Scaffold the project. Match the viewport: `cssViewport` gives the app's size in CSS pixels (e.g. 390×844 for a phone).
- Build **one screen at a time**, in flow order: layout, then components, then text, then colours, spacing and type. Use the measured tokens; don't eyeball them.
- Implement navigation and every transition with the measured **duration and easing**. Animations are part of the copy, not a nice-to-have.
- Use realistic mock data, not lorem ipsum.
- Leave out the phone OS status bar and home indicator (`suggestedCrop` tells you they were in the recording). Do keep the safe-area padding.
- Add stable `data-testid`s or `aria-label`s to tappable elements; they make `record_build` steps reliable.

## 4. Check (the loop)

1. Start the app. `record_build` can do it for you: `start_command: "npm run dev"` with `url: "http://localhost:5173"`, or `serve_dir: "dist"` for a static build.
2. Call `record_build` with:
   - `viewport`: `"phone"` (390×844) for phone recordings, or `{width, height}` = `cssViewport` for anything else.
   - `steps`: start from `infer_flow.replaySteps`, then fix the selectors and text for your build. Give every step that should be compared `capture: "<state id>"` (e.g. `"s2"`). Repeat visits are named `s1-visit2`.
3. Call `compare` with:
   - `original_frames`: the `keyframe` paths from `watch_video`, as `{path, name: "s1"}` objects.
   - `build_frames`: the screenshot paths from `record_build`, as `{path, name}` objects (names come from `capture`).
   - `crop`: `watch_video.suggestedCrop` (it strips the recorded status bar).
4. Read the result: worst screens come first, each with `metrics`, `weakest`, `mismatches` (numbered boxes plus hints such as "missing text", "colour #a vs #b", "element missing in build") and a diff image (original | build | marked differences).
5. **Fix the worst mismatches first**: the biggest-severity regions on the lowest-scoring screens. Re-run `record_build` + `compare`.
6. Stop when **every screen passes** (score ≥ 0.85 and no metric < 0.6 by default) **or after 5 rounds**. Don't loop on noise: if a screen's score improves by less than 0.01 over two rounds, move on and report it.

What the metrics mean: `visual` is structural similarity, `layout` is block positions and sizes, `color` is colour difference, `text` is OCR text match. Fonts that differ slightly cost a few points. That's fine, and it's better than copying proprietary fonts.

## 5. Side-by-side + summary

1. Run `record_build` once more with `video: true` (the default), pacing steps with `pause` close to the original hold times. The `replaySteps` from `infer_flow` already carry them.
2. Call `make_side_by_side(original, build_video, original_marks, build_marks)`:
   - `original_marks`: the start time of each transition in the original (from `infer_flow` edges' `occurrences[].time`, in path order).
   - `build_marks`: the matching `record_build` `steps[].time` (the times of the actions that trigger each transition).
   - This gives 9:16 and 16:9 MP4s with a small "Made with Remake" label. It's on by default; pass `watermark: false` if the user asks to remove it. Add `gif: true` for a README-friendly GIF.
3. Give the user a short, honest summary:
   - how to run the app,
   - a per-screen score table (final round) and how many rounds it took,
   - what matches and what doesn't (be specific: "the sheet uses a spring in the original; ours is ease-out"),
   - brand replacements made,
   - paths to the side-by-side videos.

## Troubleshooting

- `ffmpeg was not found` → tell the user to run `npx remake-agents doctor --fix` (or `brew install ffmpeg` / `winget install Gyan.FFmpeg` / `sudo apt install ffmpeg`).
- `record_build` can't find an element → use `x`/`y` fractions from `infer_flow`, or add a `data-testid` and use `selector`.
- Low `layout` score but things look right → check the viewport size matches `cssViewport`, and that `crop` is set for phone recordings.
- Very long recordings (> 2 min) → ask the user to trim to the flow they care about, or use `budget: "low"`.
