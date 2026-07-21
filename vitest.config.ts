import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["tests/fixtures/global-setup.ts"],
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
          testTimeout: 5_000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
          sequence: { concurrent: false },
        },
      },
      {
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
          environment: "node",
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
          sequence: { concurrent: false },
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*"],
      exclude: [
        "src/server.ts",
        "src/worker/index.ts",
        "src/migrate.ts",
        "src/logger.ts",
        "src/types.ts",
      ],
    },
  },
});
