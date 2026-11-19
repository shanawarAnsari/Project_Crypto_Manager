import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: "tests/nonexistent-env-dir",
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts", "src/worker.ts"]
    }
  }
});
