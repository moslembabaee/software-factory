import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
