import { randomBytes } from "node:crypto";
import { systemClock, type Clock } from "./clock.ts";

/**
 * A UUIDv7 (RFC 9562): 48-bit Unix milliseconds, version 7, 74 random bits.
 * Ids made later sort after ids made earlier (to the millisecond).
 */
export function newId(clock: Clock = systemClock): string {
  const bytes = randomBytes(16);
  const millis = clock.now().getTime();
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
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
