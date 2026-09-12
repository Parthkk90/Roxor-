import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/compiler/**/*.test.ts", "test/offchain/**/*.test.ts"],
    environment: "node",
  },
});
