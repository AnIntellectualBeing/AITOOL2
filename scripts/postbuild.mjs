// Make the CLI executable after tsc (no-op on Windows).
import { chmodSync, existsSync } from "node:fs";
const cli = new URL("../dist/cli.js", import.meta.url);
if (existsSync(cli)) {
  try { chmodSync(cli, 0o755); } catch { /* ignore */ }
}
