import type { FolderRefusal, ShareFailure } from "@not-unreachable/contracts";

// Messages never hold a path: they may reach logs.

export class ResourceNotFoundError extends Error {
  override readonly name = "ResourceNotFoundError";

  constructor() {
    super("No such resource");
  }
}

/**
 * The settings of a new or changed resource were refused; `command` fixes a `not-writable` folder,
 * which `allowFromUi` says the admin can also allow from the admin interface.
 */
export class FolderRefusedError extends Error {
  override readonly name = "FolderRefusedError";
  readonly reason: FolderRefusal;
  readonly command: string | null;
  readonly allowFromUi: boolean;

  constructor(reason: FolderRefusal, command: string | null, allowFromUi = false) {
    super(`The folder was refused (${reason})`);
    this.reason = reason;
    this.command = command;
    this.allowFromUi = allowFromUi;
  }
}

/** An SMB share's new settings didn't mount; nothing was saved. */
export class ShareRefusedError extends Error {
  override readonly name = "ShareRefusedError";
  readonly reason: ShareFailure;

  constructor(reason: ShareFailure) {
    super(`The share couldn't be mounted (${reason})`);
    this.reason = reason;
  }
}

/** A saved share's password is only ever sent to the server it was saved for (smb.md). */
export class SharePasswordRequiredError extends Error {
  override readonly name = "SharePasswordRequiredError";

  constructor() {
    super("The password must be entered again for another server");
  }
}

export class ResourceNameTakenError extends Error {
  override readonly name = "ResourceNameTakenError";

  constructor() {
    super("Another resource has this name");
  }
}

/** A change named another kind than the resource's; a resource's kind never changes. */
export class ResourceKindMismatchError extends Error {
  override readonly name = "ResourceKindMismatchError";

  constructor() {
    super("A resource's kind can't change");
  }
}

/** Why a resource can't be removed. */
export type ResourceInUse = "home-root" | "holds-homes";

export class ResourceInUseError extends Error {
  override readonly name = "ResourceInUseError";
  readonly reason: ResourceInUse;

  constructor(reason: ResourceInUse) {
    super(reason === "home-root" ? "The resource holds the home root" : "Users' homes live in the resource");
    this.reason = reason;
  }
}

export class ResourceUnavailableError extends Error {
  override readonly name = "ResourceUnavailableError";

  constructor() {
    super("The resource is unavailable");
  }
}

/** Homes can't be made until the admin picks a home root. */
export class HomeRootNotSetError extends Error {
  override readonly name = "HomeRootNotSetError";

  constructor() {
    super("No home root is set");
  }
}

/** No home is recorded for the user. */
export class HomeNotFoundError extends Error {
  override readonly name = "HomeNotFoundError";

  constructor() {
    super("No home is recorded for this user");
  }
}
