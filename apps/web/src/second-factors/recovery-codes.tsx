import { Button, Checkbox, CopyField, Icon, PRODUCT_NAME } from "@not-unreachable/design-system";

export const recoveryCodesFileName = "not-unreachable-recovery-codes.txt";

/** Saves the codes as a text file, made in the browser: they never leave it any other way. */
export function downloadRecoveryCodes(codes: readonly string[], username: string): void {
  const text = [
    `${PRODUCT_NAME} recovery codes for ${username}`,
    "",
    ...codes,
    "",
    "Each code signs you in once in place of your authenticator app.",
    "",
  ].join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = recoveryCodesFileName;
  link.click();
  // The click has started the download by the next task.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface RecoveryCodesPanelProps {
  readonly codes: readonly string[];
  /** Whose codes they are, for the downloaded file. */
  readonly username: string;
  /** Whether the person said they saved the codes. */
  readonly saved: boolean;
  readonly onSavedChange: (saved: boolean) => void;
}

/**
 * New recovery codes, shown once: to copy or download, with the "I saved them" box the screen's
 * Continue or Done waits for.
 */
export function RecoveryCodesPanel({ codes, username, saved, onSavedChange }: RecoveryCodesPanelProps) {
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 type-body-sm text-fg-2">
        Each code signs you in once if you lose your authenticator app. They are shown only now: save them somewhere safe.
      </p>
      <CopyField label="Recovery codes" value={codes.join("\n")} />
      <div>
        <Button variant="secondary" iconLeft={<Icon name="download" size={16} />} onClick={() => downloadRecoveryCodes(codes, username)}>
          Download codes
        </Button>
      </div>
      <Checkbox label="I saved my recovery codes" checked={saved} onChange={onSavedChange} />
    </div>
  );
}
