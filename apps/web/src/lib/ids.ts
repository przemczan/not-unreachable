/**
 * A UUIDv7 (RFC 9562), made as the server makes its ids (`apps/server/src/modules/platform/ids.ts`):
 * 48-bit Unix milliseconds, version 7, 74 random bits. For records whose id the page needs
 * before the server has them, such as a new sign-in provider's redirect URI.
 */
export function newId(now: Date = new Date()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const millis = now.getTime();
  // 48-bit big-endian timestamp; split to stay within safe bitwise ranges.
  const high = Math.floor(millis / 2 ** 16);
  bytes[0] = (high >>> 24) & 0xff;
  bytes[1] = (high >>> 16) & 0xff;
  bytes[2] = (high >>> 8) & 0xff;
  bytes[3] = high & 0xff;
  bytes[4] = (millis >>> 8) & 0xff;
  bytes[5] = millis & 0xff;
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
