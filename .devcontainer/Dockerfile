# Node 24 to match .nvmrc; the full Debian image has the toolchain better-sqlite3 needs if no prebuilt binary fits.
FROM node:24-bookworm

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# pnpm comes from Corepack at the version package.json's packageManager pins.
RUN corepack enable && corepack prepare pnpm@12.22.0 --activate

# Chromium and its system libraries for test:e2e; keep the version in step with @playwright/test in package.json.
RUN npx --yes playwright@1.65.1 install --with-deps chromium \
    && chmod -R a+rx /ms-playwright
