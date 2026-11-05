import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, which } from "./exec.js";
import { findTools, type VideoInfo } from "./ffmpeg.js";
import { ensureDir, remakeHome } from "./paths.js";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptResult {
  status: "ok" | "no_audio" | "silent" | "skipped" | "unavailable" | "failed";
  engine?: string;
  segments: TranscriptSegment[];
  note?: string;
}

export function whisperHelp(): string {
  return [
    "To transcribe narration, install one of:",
    "  whisper.cpp:     brew install whisper-cpp  (macOS) — then put a model at ~/.remake/models/ggml-base.en.bin",
    "                   or set REMAKE_WHISPER_MODEL=/path/to/ggml-model.bin",
    "  faster-whisper:  pipx install whisper-ctranslate2",
  ].join("\n");
}

function findWhisperCppModel(): string | null {
  const env = process.env.REMAKE_WHISPER_MODEL;
  if (env && existsSync(env)) return env;
  const dirs = [path.join(remakeHome(), "models"), path.join(os.homedir(), ".cache", "whisper"), path.join(os.homedir(), "whisper.cpp", "models")];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    const f = readdirSync(d)
      .filter((x) => /^ggml-.*\.bin$/.test(x))
      .sort((a, b) => (a.includes("base") ? -1 : 0) - (b.includes("base") ? -1 : 0))[0];
    if (f) return path.join(d, f);
  }
  return null;
}

/** Is there any audible sound in the recording? (avoids running whisper on silence) */
async function isSilent(file: string): Promise<boolean> {
  const { ffmpeg } = findTools();
  const r = await run(ffmpeg, ["-hide_banner", "-nostdin", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"], {
    allowFailure: true,
    label: "ffmpeg",
  });
  const m = r.stderr.match(/max_volume:\s*(-?[\d.]+|-inf) dB/);
  if (!m) return false;
  return m[1] === "-inf" || Number(m[1]) < -45;
}

/** Transcribe narration with a local whisper engine, if one is installed. */
export async function transcribe(info: VideoInfo, workDir: string): Promise<TranscriptResult> {
  if (!info.hasAudio) return { status: "no_audio", segments: [] };
  if (await isSilent(info.path)) return { status: "silent", segments: [], note: "The audio track is silent." };

  const cpp = which("whisper-cli") ?? which("whisper-cpp") ?? which("whisper.cpp");
  const ct2 = which("whisper-ctranslate2");
  const py = which("whisper");
  const model = findWhisperCppModel();
  if (!(cpp && model) && !ct2 && !py) {
    return { status: "unavailable", segments: [], note: `Narration not transcribed: no local whisper engine found.\n${whisperHelp()}` };
  }
  const dir = ensureDir(path.join(workDir, "audio"));
  const wav = path.join(dir, "audio.wav");
  const { ffmpeg } = findTools();
  await run(ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", info.path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], {
    label: "ffmpeg",
  });
  try {
    if (cpp && model) {
      const base = path.join(dir, "transcript");
      await run(cpp, ["-m", model, "-f", wav, "-oj", "-of", base, "-np"], { label: "whisper.cpp", timeoutMs: 20 * 60_000 });
      const j = JSON.parse(readFileSync(base + ".json", "utf8"));
      const segments = (j.transcription ?? []).map((s: any) => ({
        start: (s.offsets?.from ?? 0) / 1000,
        end: (s.offsets?.to ?? 0) / 1000,
        text: String(s.text ?? "").trim(),
      }));
      return { status: "ok", engine: "whisper.cpp", segments: segments.filter((s: TranscriptSegment) => s.text) };
    }
    const engine = ct2 ? "faster-whisper" : "openai-whisper";
    const bin = (ct2 ?? py)!;
    await run(bin, [wav, "--model", "base", "--output_format", "json", "--output_dir", dir], {
      label: engine,
      timeoutMs: 20 * 60_000,
    });
    const j = JSON.parse(readFileSync(path.join(dir, "audio.json"), "utf8"));
    const segments = (j.segments ?? []).map((s: any) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text ?? "").trim() }));
    return { status: "ok", engine, segments: segments.filter((s: TranscriptSegment) => s.text) };
  } catch (e) {
    return { status: "failed", segments: [], note: `Transcription failed: ${(e as Error).message}` };
  }
}
