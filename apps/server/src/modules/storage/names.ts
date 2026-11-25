import type { NameCheck } from "./types.ts";

export const MAX_SEGMENT_BYTES = 255;

/** Names Windows reserves for devices, with or without an extension (`con.txt`); they break SMB shares. */
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const RESERVED_CHARACTER = /[<>:"|?*\\]/;

/** True if the text holds a C0 control character or DEL (NUL included). */
export function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

/** T5 step 7: the rules a new name (upload, new folder, rename) must pass. Answers the name in NFC. */
export function checkName(name: string): NameCheck {
  if (!name.isWellFormed()) return { ok: false, reason: "reserved-character" };
  const normal = name.normalize("NFC");
  if (normal === "") return { ok: false, reason: "empty" };
  if (normal === "." || normal === "..") return { ok: false, reason: "dot" };
  if (normal.includes("/")) return { ok: false, reason: "slash" };
  if (hasControlCharacter(normal)) return { ok: false, reason: "control-character" };
  if (RESERVED_CHARACTER.test(normal)) return { ok: false, reason: "reserved-character" };
  if (Buffer.byteLength(normal, "utf8") > MAX_SEGMENT_BYTES) return { ok: false, reason: "too-long" };
  if (normal.endsWith(".") || normal.endsWith(" ")) return { ok: false, reason: "trailing-dot-or-space" };
  // Windows ignores the extension and trailing spaces of the stem: `CON .txt` is the device too.
  const stem = (normal.split(".")[0] ?? "").trimEnd();
  if (RESERVED_NAME.test(stem)) return { ok: false, reason: "reserved-name" };
  return { ok: true, name: normal };
}
