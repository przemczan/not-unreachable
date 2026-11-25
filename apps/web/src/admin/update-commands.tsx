import type { UpdatesOverview } from "@not-unreachable/contracts";
import { Alert, CopyField, useToast, type CopyOutcome } from "@not-unreachable/design-system";
import { UPDATE_JOURNAL_COMMAND, UPDATE_RECOVER_COMMAND, type UpdateFollowUp } from "./update-wording.ts";

/** Says so when a command was copied, as the other commands of the admin pages do. */
function useCopied(): (outcome: CopyOutcome) => void {
  const toast = useToast();
  return (outcome) => {
    if (outcome === "copied") toast.show({ tone: "success", title: "Command copied" });
  };
}

/** A command to run on the server, with its label. */
export function ServerCommand({ label, value }: { readonly label?: string; readonly value: string }) {
  const copied = useCopied();
  return label === undefined ? (
    <CopyField what="command" value={value} onCopy={copied} />
  ) : (
    <CopyField label={label} value={value} onCopy={copied} />
  );
}

/** Installing from here is off: the one-line installer, and the command that turns it on. */
export function InstallElsewhere({ install }: { readonly install: UpdatesOverview["install"] }) {
  return (
    <Alert tone="info" title="Install it on the server">
      <div className="mt-1 flex flex-col gap-3">
        <p className="m-0">
          Installing from here is turned off. Run the installer on the server, or turn installing from here on, then come back.
        </p>
        <ServerCommand label="Install over SSH" value={install.installerCommand} />
        <ServerCommand label="Or turn installing from here on" value={install.switchCommand} />
      </div>
    </Alert>
  );
}

/** What a result asks the admin to do on the server, or to report. */
export function FollowUp({ followUp, install }: { readonly followUp: UpdateFollowUp; readonly install: UpdatesOverview["install"] }) {
  if (followUp === "installer") return <ServerCommand label="Install over SSH" value={install.installerCommand} />;
  if (followUp === "switch") return <ServerCommand label="Turn installing from here on" value={install.switchCommand} />;
  if (followUp === "recover") return <ServerCommand value={UPDATE_RECOVER_COMMAND} />;
  if (followUp === "journal") return <ServerCommand label="See what happened, on the server" value={UPDATE_JOURNAL_COMMAND} />;
  if (followUp === "report") return <Alert tone="neutral">Try again later. If it happens again, report it on GitHub.</Alert>;
  return null;
}
