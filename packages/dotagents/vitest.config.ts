import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const moduleDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      "@sentry/dotagents-lib": resolve(moduleDir, "../dotagents-lib/src/index.ts"),
    },
  },
});
