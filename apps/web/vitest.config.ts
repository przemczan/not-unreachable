import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["@not-unreachable/source"] },
  test: {
    name: "web",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
  },
});
