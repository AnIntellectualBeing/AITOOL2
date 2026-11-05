import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Root of the installed package (works from dist/ and from src/ under tests). */
export const PACKAGE_ROOT = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "skill"))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
})();

export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

export const SKILL_DIR = path.join(PACKAGE_ROOT, "skill");

/** The skill instructions without YAML front matter. */
export function skillText(): string {
  const raw = readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
  return raw.replace(/^---[\s\S]*?---\s*/, "");
}
