import { defineConfig } from "vitest/config";

// The hostile-request tests need root, so `pnpm test` leaves them out; CI runs them as root with
// `pnpm test:helper-root`.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "mount-helper-root",
    environment: "node",
    include: ["test-root/**/*.test.ts"],
  },
});
