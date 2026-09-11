import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // several tests shell out to real git in temp repos; under full-suite worker
    // parallelism that occasionally exceeds vitest's 5s default.
    testTimeout: 15_000,
    coverage: {
      include: [
        "src/core/**",
        "src/ingest/**",
        "src/report/**",
        "src/llm/**",
        "src/pipeline.ts",
        "src/run.ts",
        "src/explain.ts",
        "src/config.ts",
        "action/comment.ts",
      ],
      exclude: [
        "src/llm/providers/anthropic.ts", // live-only; covered by the skipped integration test
        "action/index.ts", // thin glue; exercised by the bundled-action smoke, not unit tests
      ],
      reporter: ["text", "json-summary"],
    },
  },
});
