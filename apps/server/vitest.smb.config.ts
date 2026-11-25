import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The SMB integration test (`pnpm test:smb`): it mounts a real share through the mount helper,
// systemd and polkit, so it runs only in the CI job that sets them up (.github/workflows/ci.yml,
// job `smb`). The normal server project leaves these files out.
const conditions = ["@not-unreachable/source", "node", "development|production"];

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    name: "server-smb",
    environment: "node",
    include: ["src/**/*.smb.test.ts"],
    // A mount waits on systemd, polkit and the Samba server.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One share, one admin, steps in order.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
