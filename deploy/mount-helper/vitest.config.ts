import { defineProject } from "vitest/config";

// Node tests resolve through the SSR environment, which ignores `resolve.conditions`; both are set so
// the contracts the tests check the status file against load from source without a build.
const conditions = ["@not-unreachable/source", "node", "development|production"];

export default defineProject({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    name: "mount-helper",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
