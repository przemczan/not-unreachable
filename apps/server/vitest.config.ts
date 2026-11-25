import { configDefaults, defineProject } from "vitest/config";

// Node tests resolve through the SSR environment, which ignores `resolve.conditions`; both are set so
// workspace packages load from source without a build.
const conditions = ["@not-unreachable/source", "node", "development|production"];

export default defineProject({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    name: "server",
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // The SMB integration test needs a real share, systemd and polkit: `pnpm test:smb` (vitest.smb.config.ts).
    exclude: [...configDefaults.exclude, "src/**/*.smb.test.ts"],
  },
});
