import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  routes,
  shareLinkDetailSchema,
  type CreateShareLinkRequest,
  type RouteContract,
  type ShareLinkDetail,
} from "@not-unreachable/contracts";
import type { LightMyRequestResponse } from "fastify";
import { expect } from "vitest";
import { buildFilesTestApp, callFilesRoute, type FilesCallOptions, type FilesTestApp } from "./files.ts";
import { tableRows } from "./sessions.ts";

/** What the shared resource holds: a folder with files and a subfolder, and a file on its own. */
export const sharedContent = {
  report: "0123456789abcdefghij",
  single: "just one file",
  nested: "deep inside",
} as const;

export interface ShareLinksTestApp extends FilesTestApp {
  /** Creates a link as the admin; throws unless it answers 201. */
  createLink(request: Omit<CreateShareLinkRequest, "resourceId"> & { readonly resourceId?: string }): Promise<CreatedShareLink>;
  /** Calls an admin route as the admin, in a session of its own (so a test may move the clock far ahead). */
  asAdmin(route: Pick<RouteContract, "method" | "path">, options?: FilesCallOptions): Promise<LightMyRequestResponse>;
  /** Calls a public share route with the token, as an anonymous browser (from `ip` when given). */
  asPublic(
    route: Pick<RouteContract, "method" | "path">,
    token: string,
    options?: FilesCallOptions & { readonly ip?: string },
  ): Promise<LightMyRequestResponse>;
  /** The link's row, as SQLite stores it. */
  row(id: string): Record<string, unknown>;
}

export interface CreatedShareLink extends ShareLinkDetail {
  readonly token: string;
}

/** The token at the end of a share link's URL. */
export function tokenOfShareLink(link: string): string {
  const marker = "/s/";
  return decodeURIComponent(link.slice(link.lastIndexOf(marker) + marker.length));
}

/** The files test app, with `docs/` (report.pdf, sub/nested.txt) and single.txt in the admin's resource. */
export async function buildShareLinksTestApp(): Promise<ShareLinksTestApp> {
  const files = await buildFilesTestApp();
  mkdirSync(join(files.resourceDir, "docs", "sub"), { recursive: true });
  writeFileSync(join(files.resourceDir, "docs", "report.pdf"), sharedContent.report);
  writeFileSync(join(files.resourceDir, "docs", "sub", "nested.txt"), sharedContent.nested);
  writeFileSync(join(files.resourceDir, "single.txt"), sharedContent.single);

  const asAdmin: ShareLinksTestApp["asAdmin"] = (route, options = {}) =>
    callFilesRoute(files.test, route, { cookie: files.test.startSession(files.admin), ...options });

  return {
    ...files,
    asAdmin,
    createLink: async (request) => {
      const response = await asAdmin(routes.createShareLink, { payload: { resourceId: files.resourceId, ...request } });
      if (response.statusCode !== 201) throw new Error(`Creating a share link failed with ${response.statusCode}: ${response.body}`);
      const detail = shareLinkDetailSchema.parse(response.json());
      return { ...detail, token: tokenOfShareLink(detail.link) };
    },
    asPublic: (route, token, { ip, headers, ...options } = {}) =>
      callFilesRoute(files.test, route, {
        params: token,
        ...options,
        headers: { ...(ip === undefined ? {} : { "x-forwarded-for": ip }), ...headers },
      }),
    row: (id) => {
      const row = tableRows(files.test, "share_links").find((candidate) => candidate["id"] === id);
      expect(row).toBeDefined();
      return row ?? {};
    },
  };
}

/** The `Set-Cookie` values of a response. */
export function setCookiesOf(response: LightMyRequestResponse): string[] {
  const header = response.headers["set-cookie"];
  return Array.isArray(header) ? header : header === undefined ? [] : [header];
}

/** The `Cookie` header value a browser sends back for a `Set-Cookie`. */
export function cookieFromSetCookie(setCookie: string): string {
  return setCookie.slice(0, setCookie.indexOf(";"));
}
