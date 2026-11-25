import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*", "scripts", "deploy/mount-helper", "deploy/install"],
  },
});
