// @vitest-environment node
/**
 * Nothing the design system ships, nor the built web app, loads from a CDN or any other origin:
 * fonts, icons and styles are bundled. An `http(s)://` URL may appear only as an identifier the
 * browser never fetches (an XML namespace, a licence or error-message link), each allowed below
 * with its reason.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageSource = fileURLToPath(new URL("../src", import.meta.url));
const webDist = fileURLToPath(new URL("../../../apps/web/dist", import.meta.url));

/** The package's text files; fonts and the PNG icon are binary and hold no URL. */
const PACKAGE_TEXT = /\.(?:ts|tsx|css|svg|md|txt)$/;

const CDN_HOSTS = [
  /unpkg\.com/i,
  /cdn\.jsdelivr\.net/i,
  /cdnjs\.cloudflare\.com/i,
  /\besm\.sh\b/i,
  /skypack/i,
  /fonts\.googleapis\.com/i,
  /fonts\.gstatic\.com/i,
  /use\.typekit\.net/i,
  /kit\.fontawesome\.com/i,
];

interface AllowedUrl {
  /** The URL, matched as a prefix. */
  readonly url: string;
  /** The files it may appear in, by their path from the scanned folder. */
  readonly files: RegExp;
  readonly reason: string;
}

const ALLOWED_URLS: readonly AllowedUrl[] = [
  { url: "http://www.w3.org/2000/svg", files: /\.(?:svg|js)$/, reason: "The SVG namespace (xmlns), an identifier never fetched." },
  { url: "http://www.w3.org/1999/xlink", files: /\.js$/, reason: "React DOM's XLink namespace, an identifier never fetched." },
  { url: "http://www.w3.org/XML/1998/namespace", files: /\.js$/, reason: "React DOM's XML namespace, an identifier never fetched." },
  { url: "http://www.w3.org/1998/Math/MathML", files: /\.js$/, reason: "React DOM's MathML namespace, an identifier never fetched." },
  { url: "https://react.dev/errors/", files: /\.js$/, reason: "The link in React's minified error messages: text, never fetched." },
  { url: "https://reactrouter.com/", files: /\.js$/, reason: "The link in a React Router error message: text, never fetched." },
  { url: "http://localhost", files: /\.js$/, reason: "React Router's placeholder base for parsing URLs with new URL(): never fetched." },
  {
    url: "https://github.com/ungap/url-search-params",
    files: /\.js$/,
    reason: "A React Router warning's text about a polyfill: never fetched.",
  },
  { url: "http://[${e}]", files: /\.js$/, reason: "Zod's IPv6 check parses the address with new URL(): never fetched." },
  { url: "https://json-schema.org/", files: /\.js$/, reason: "Zod's JSON Schema $schema identifiers: never fetched." },
  { url: "http://json-schema.org/", files: /\.js$/, reason: "Zod's JSON Schema $schema identifiers: never fetched." },
  {
    url: "https://next.invalid",
    files: /\.js$/,
    reason: "The sign-in ?next= check's placeholder base for new URL() (a reserved .invalid name): never fetched.",
  },
  {
    url: "https://login.example.com",
    files: /\.js$/,
    reason: "The Sign-in providers drawer's Issuer placeholder (a reserved example.com name): text, never fetched.",
  },
  ...[
    "https://console.cloud.google.com/auth/clients",
    "https://support.google.com/cloud/answer/15549257",
    "https://github.com/settings/developers",
    "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app",
    "https://openid.net/specs/openid-connect-discovery-1_0.html",
  ].map((url) => ({
    url,
    files: /\.js$/,
    reason: "A link in the Sign-in providers drawer's setup help, which the admin opens in a new tab: never fetched by the app.",
  })),
  {
    url: "https://github.com/przemczan/not-unreachable/releases",
    files: /\.js$/,
    reason: "Settings → Updates' link to the release notes, which the admin opens in a new tab: never fetched by the app.",
  },
  {
    url: "https://simplewebauthn.dev/docs/",
    files: /\.js$/,
    reason: "The link in a @simplewebauthn/browser console warning about a wrong call: text, never fetched.",
  },
  { url: "https://tailwindcss.com", files: /\.css$/, reason: "Tailwind's licence banner comment in the compiled CSS." },
  { url: "https://openfontlicense.org", files: /fonts\/OFL\.txt$/, reason: "The licence text of the bundled Geist fonts." },
  { url: "https://github.com/vercel/geist-font", files: /fonts\/OFL\.txt$/, reason: "The copyright line of the Geist fonts' licence." },
  { url: "https://lucide.dev", files: /brand\/NOTICE\.md$/, reason: "The attribution of the placeholder mark's Lucide glyph." },
];

const URL_PATTERN = /https?:\/\/[^\s"'`()<>\\,]+/gi;

function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
}

/** Every CDN host and disallowed URL in the folder's text files, as "file: match". */
function offenders(root: string, isText: (file: string, contents: Buffer) => boolean): string[] {
  const found: string[] = [];
  for (const file of filesUnder(root)) {
    const contents = readFileSync(path.join(root, file));
    if (!isText(file, contents)) continue;
    const text = contents.toString("utf8");
    for (const host of CDN_HOSTS) {
      const match = host.exec(text);
      if (match !== null) found.push(`${file}: CDN host ${match[0]}`);
    }
    for (const [url] of text.matchAll(URL_PATTERN)) {
      const allowed = ALLOWED_URLS.some((entry) => url.startsWith(entry.url) && entry.files.test(file));
      if (!allowed) found.push(`${file}: ${url}`);
    }
  }
  return found;
}

describe("no CDN or off-origin URL", () => {
  it("in packages/design-system/src", () => {
    expect(filesUnder(packageSource).filter((file) => PACKAGE_TEXT.test(file)).length).toBeGreaterThan(0);
    expect(offenders(packageSource, (file) => PACKAGE_TEXT.test(file))).toEqual([]);
  });

  // The build writes apps/web/dist (the Tests stage runs `pnpm build` first); without it this checks nothing.
  it.runIf(existsSync(webDist))("in the built apps/web/dist, when present", () => {
    expect(filesUnder(webDist).length).toBeGreaterThan(0);
    // Every file but binary ones (fonts, images), which hold a NUL byte.
    expect(offenders(webDist, (_file, contents) => !contents.includes(0))).toEqual([]);
  });

  it("every allowed URL has a reason", () => {
    expect(ALLOWED_URLS.filter((entry) => entry.reason.trim() === "").map((entry) => entry.url)).toEqual([]);
  });
});
