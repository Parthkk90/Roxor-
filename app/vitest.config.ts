import { defineConfig } from "vitest/config";
import { clfResolver } from "./src/vite-clf-resolver.js";

export default defineConfig({
  // Same resolver the app build uses, so the strategy tests exercise the real CLF compiler rather
  // than a test-only copy of it.
  plugins: [clfResolver()],
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
  },
});
