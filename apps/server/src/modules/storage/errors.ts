import type { NameRefusal, PathRefusal } from "./types.ts";

// Messages never hold a path: they may reach logs, and a path would tell where a resource lives.

/** A path broke a T5 rule, or changed under us between resolving and opening it. */
export class PathRefusedError extends Error {
  override readonly name = "PathRefusedError";
  readonly reason: PathRefusal;

  constructor(reason: PathRefusal) {
    super(`The path was refused (${reason})`);
    this.reason = reason;
  }
}

/** A new name broke a T5 step 7 rule. */
export class NameRefusedError extends Error {
  override readonly name = "NameRefusedError";
  readonly reason: NameRefusal;

  constructor(reason: NameRefusal) {
    super(`The name was refused (${reason})`);
    this.reason = reason;
  }
}

/** The name is taken and the caller chose not to replace it (or the entry there can't be replaced). */
export class NameTakenError extends Error {
  override readonly name = "NameTakenError";

  constructor() {
    super("The name is already taken");
  }
}

/** The `code` of a Node system error (`ENOENT`, `ELOOP`…), if it has one. */
export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
