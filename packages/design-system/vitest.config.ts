import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "design-system",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts", "lint/**/*.test.ts", "test/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
  },
});
