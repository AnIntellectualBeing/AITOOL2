import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { RemakeError } from "./errors.js";

export interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: Buffer | string;
  timeoutMs?: number;
  /** Called with each stdout chunk; when set, stdout is NOT buffered. */
  onStdout?: (chunk: Buffer) => void;
  onStderrLine?: (line: string) => void;
  allowFailure?: boolean;
  /** Friendly name for error messages, e.g. "ffmpeg". */
  label?: string;
  maxStderr?: number;
}

/** Run a program with an argument array (no shell), collecting output. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    };
    let child;
    try {
      child = spawn(cmd, args, spawnOpts);
    } catch (e) {
      reject(new RemakeError("spawn_failed", `Could not start ${opts.label ?? cmd}: ${(e as Error).message}`));
      return;
    }
    const out: Buffer[] = [];
    let err = "";
    const maxStderr = opts.maxStderr ?? 200_000;
    let lineBuf = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }
    child.stdout!.on("data", (c: Buffer) => {
      if (opts.onStdout) opts.onStdout(c);
      else out.push(c);
    });
    child.stderr!.on("data", (c: Buffer) => {
      const s = c.toString("utf8");
      if (err.length < maxStderr) err += s;
      else err = err.slice(-maxStderr / 2) + s;
      if (opts.onStderrLine) {
        lineBuf += s;
        let idx;
        while ((idx = lineBuf.search(/[\r\n]/)) >= 0) {
          const line = lineBuf.slice(0, idx);
          lineBuf = lineBuf.slice(idx + 1);
          if (line) opts.onStderrLine(line);
        }
      }
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      if (e.code === "ENOENT") {
        reject(new RemakeError("not_found", `${opts.label ?? cmd} is not installed or not on your PATH.`));
      } else {
        reject(new RemakeError("spawn_failed", `Could not run ${opts.label ?? cmd}: ${e.message}`));
      }
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (opts.onStderrLine && lineBuf) opts.onStderrLine(lineBuf);
      const result = { code: code ?? -1, stdout: Buffer.concat(out), stderr: err };
      if (result.code !== 0 && !opts.allowFailure) {
        const tail = err.trim().split(/\r?\n/).slice(-6).join("\n");
        reject(
          new RemakeError(
            "command_failed",
            `${opts.label ?? path.basename(cmd)} failed (exit code ${result.code}).${tail ? `\n${tail}` : ""}`,
          ),
        );
        return;
      }
      resolve(result);
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    else child.stdin!.end();
  });
}

/** Find an executable on PATH (handles Windows PATHEXT). */
export function which(name: string): string | null {
  const isWin = process.platform === "win32";
  const exts = isWin ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidates = isWin && path.extname(name) ? [name] : [name + ext.toLowerCase(), name + ext];
      for (const c of candidates) {
        const full = path.join(dir, c);
        try {
          if (existsSync(full) && statSync(full).isFile()) return full;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return null;
}

/** Run async tasks with a concurrency limit, preserving order of results. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
