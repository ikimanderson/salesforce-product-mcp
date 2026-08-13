import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Mirror tsconfig paths: "@/*" -> repo root.
      "@": path.resolve(__dirname, "."),
    },
  },
});
