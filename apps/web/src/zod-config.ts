import { z } from "zod";

/**
 * Zod compiles object parsers with `new Function` when it can, probing for it with `Function("")`
 * as each object schema is built. The CSP's Trusted Types refuse both, which shows as a violation:
 * parse without them. Imported first by main.tsx, so it runs before any schema is built.
 */
z.config({ jitless: true });
