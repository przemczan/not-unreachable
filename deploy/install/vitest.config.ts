import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "install",
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Most tests run the real install.sh several times (about a second each while the whole suite
    // runs in parallel), which the default 5 s leaves no room for.
    testTimeout: 20_000,
  },
});
