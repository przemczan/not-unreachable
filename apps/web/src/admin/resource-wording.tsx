import {
  folderRefusals,
  type AllowFolderRefusal,
  isShareFailure,
  problemTypes,
  smbEncrypts,
  type FolderRefusal,
  type Resource,
  type ResourceCheck,
  type ResourceKind,
  type ShareFailure,
  type SmbProtocol,
  type UnavailableReason,
} from "@not-unreachable/contracts";
import { Alert, Button, CopyField, useToast } from "@not-unreachable/design-system";
import { ApiError } from "../api/index.ts";

/** Why a saved resource is unavailable, in a few words beside its Badge. */
export const unavailableReasonLabels: Record<UnavailableReason, string> = {
  missing: "Folder missing",
  "not-a-folder": "Not a folder",
  changed: "Folder changed since it was saved",
  "not-writable": "Service can't write to it",
  auth: "Sign-in refused",
  unreachable: "Server unreachable",
  "no-share": "Share not found",
  "not-supported": "Protocol not supported",
  "mount-failed": "Mount failed",
  "helper-unavailable": "Mounting isn't set up",
};

/** What kind of resource it is, as the Add resource menu and the Files resource picker word it. */
export const resourceKindLabels: Record<ResourceKind, string> = {
  local: "Local folder",
  smb: "SMB share",
};

/** The warning the form and the Resources list show for a share whose traffic isn't encrypted. */
export const UNENCRYPTED_WARNING = "Traffic to this share is not encrypted";

/** Whether the resource is an SMB share whose traffic isn't encrypted. */
export function isUnencryptedShare(resource: Resource): boolean {
  return resource.kind === "smb" && !smbEncrypts(resource.protocol, resource.encrypt);
}

/** An SMB share's address, as `//host/share/folder`. */
export function shareAddressOf(share: { readonly host: string; readonly share: string; readonly subfolder: string }): string {
  const folder = share.subfolder.replace(/^\/+|\/+$/g, "");
  return `//${share.host}/${share.share}${folder === "" ? "" : `/${folder}`}`;
}

/** Where the resource is: a local folder's path, or a share's address. */
export function resourceLocationOf(resource: Resource): string {
  return resource.kind === "local" ? resource.localPath : shareAddressOf(resource);
}

/** The protocols the SMB form offers, by their label. */
export const smbProtocolLabels: Record<SmbProtocol, string> = {
  "3.1.1": "SMB 3.1.1",
  "3.0": "SMB 3.0",
  "2.1": "SMB 2.1 (older servers)",
};

/** Why "Check folder" or saving refused a folder, and what to do. */
const folderRefusalMessages: Record<FolderRefusal, string> = {
  "not-absolute": "Enter the full path of the folder, starting with /.",
  missing: "There is no folder at this path on the server.",
  "not-a-folder": "Something other than a folder is at this path.",
  "not-writable": "The service can't write to this folder.",
  "inside-data-directory": "This folder overlaps NotUnreachable's own data folder. Choose another folder.",
  "inside-release-directory": "This folder overlaps the folder NotUnreachable is installed in. Choose another folder.",
  "inside-mount-root": "This folder overlaps the folder network shares are mounted in. Choose another folder.",
};

/** Why a folder can't be allowed from the admin interface, and what to do. */
export const allowFolderRefusalMessages: Record<AllowFolderRefusal, string> = {
  "not-absolute": folderRefusalMessages["not-absolute"],
  missing: folderRefusalMessages.missing,
  "not-a-folder": folderRefusalMessages["not-a-folder"],
  "inside-data-directory": folderRefusalMessages["inside-data-directory"],
  "inside-release-directory": folderRefusalMessages["inside-release-directory"],
  "inside-mount-root": folderRefusalMessages["inside-mount-root"],
  "outside-allowed-folders":
    "This folder isn't inside one of the folders the server lets you allow from here. Run the command on the server instead.",
  "system-folder": "This is a system folder, or holds one, so it can't be allowed from here. Choose another folder.",
  "unsupported-path":
    "The path has a character the service's settings can't hold, such as a backslash or a double quote. Run the command on the server instead.",
  "overlaps-allowed-folder":
    "This folder is inside a folder the service can already write to, or holds one, so it can't be allowed from here. Run the command on the server instead.",
};

/** Why "Test connection" or saving couldn't mount a share, and what to do. */
export const shareFailureMessages: Record<ShareFailure, string> = {
  auth: "The server refused the user name or password.",
  unreachable: "The server can't be reached. Check its name or address, and that it is on.",
  "no-share": "The server has no share by this name, or the folder in the share doesn't exist.",
  "not-supported": "The server doesn't support this protocol or encryption. Try another protocol.",
  "mount-failed": "The share couldn't be mounted. The server's log says why.",
  "helper-unavailable": "This server isn't set up to mount shares yet. Run the install script again.",
};

type FolderRefused = Extract<ResourceCheck, { outcome: "refused" }>;
type ShareFailed = Extract<ResourceCheck, { outcome: "failed" }>;

function isFolderRefusal(reason: string | undefined): reason is FolderRefusal {
  return folderRefusals.some((refusal) => refusal === reason);
}

/** A `folder-refused` problem as a "Check folder" result, or null for any other error. */
export function folderRefusalOf(error: unknown): FolderRefused | null {
  if (!(error instanceof ApiError) || error.type !== problemTypes.folderRefused) return null;
  const { reason, command, allowFromUi } = error.problem;
  if (!isFolderRefusal(reason)) return null;
  return { outcome: "refused", reason, command: command ?? null, allowFromUi: allowFromUi ?? false };
}

/** A `share-refused` problem as a "Test connection" result, or null for any other error. */
export function shareRefusalOf(error: unknown): ShareFailed | null {
  if (!(error instanceof ApiError) || error.type !== problemTypes.shareRefused) return null;
  const { reason } = error.problem;
  if (reason === undefined || !isShareFailure(reason)) return null;
  return { outcome: "failed", reason };
}

function foldersFound(count: number): string {
  if (count === 0) return "no folders found";
  return count === 1 ? "1 folder found" : `${count} folders found`;
}

export interface ResourceCheckAlertProps {
  readonly result: ResourceCheck;
  /**
   * Offers "Allow this folder" for a folder the service can't write to, when the server lets the
   * admin allow it from here (`allowFromUi`); left out, only the command is shown.
   */
  readonly onAllowFolder?: (() => void) | undefined;
}

/**
 * The result of "Check folder" or "Test connection", or a save the server refused: what to do
 * about it, as text.
 */
export function ResourceCheckAlert({ result, onAllowFolder }: ResourceCheckAlertProps) {
  const toast = useToast();
  switch (result.outcome) {
    case "ok":
      return (
        <Alert tone="success" title="The service can use this folder">
          It exists, is a folder and the service can write to it.
        </Alert>
      );
    case "connected":
      return (
        <Alert tone="success" title={`Signed in, ${foldersFound(result.folderCount)}`}>
          The service can use this share.
        </Alert>
      );
    case "failed":
      return (
        <Alert tone="danger" title="This share can't be used">
          {shareFailureMessages[result.reason]}
        </Alert>
      );
    case "refused":
      break;
  }
  if (result.reason === "not-writable" && result.command !== null) {
    return (
      <Alert tone="warning" title="The service can't write to this folder">
        <div className="mt-1 flex flex-col gap-2">
          {result.allowFromUi && onAllowFolder !== undefined ? (
            <>
              <p className="m-0">
                Allow the service to write to it from here, or run this command on the server, then check the folder again.
              </p>
              <div>
                <Button size="sm" onClick={onAllowFolder}>
                  Allow this folder
                </Button>
              </div>
            </>
          ) : (
            <p className="m-0">Run this command on the server, then check the folder again.</p>
          )}
          <CopyField
            label="Command"
            value={result.command}
            onCopy={(outcome) => {
              if (outcome === "copied") toast.show({ tone: "success", title: "Command copied" });
            }}
          />
          <p className="m-0">If the command doesn't help, the not-unreachable user needs write permission on the folder.</p>
        </div>
      </Alert>
    );
  }
  return (
    <Alert tone="danger" title="This folder can't be used">
      {folderRefusalMessages[result.reason]}
    </Alert>
  );
}
