import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    pool: "forks",
    // The end-to-end tests drive ffmpeg, Chromium and OCR; run files one at a time.
    fileParallelism: false,
  },
});
