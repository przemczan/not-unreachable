const ASCII_ESCAPE = /%([0-7][0-9A-Fa-f])/g;
/** Escapes that would change the URL's structure; the router leaves them encoded too. */
const STRUCTURAL = new Set(["/", "?", "#"]);

/**
 * Decodes a URL's percent-escaped ASCII characters, except `/`, `?` and `#`. The router matches
 * paths decoded like this (`/%61pi/v1/health` reaches `/api/v1/health`), so a check by path prefix
 * must look at the same form. A malformed escape stays as it is.
 */
export function decodeAsciiEscapes(url: string): string {
  return url.replaceAll(ASCII_ESCAPE, (escape, hex: string) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    return STRUCTURAL.has(character) ? escape : character;
  });
}
