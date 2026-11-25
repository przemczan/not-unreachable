import type { UpdatePhase } from "@not-unreachable/contracts";
import { Alert, Button, CopyField, Icon, ProgressBar, cn } from "@not-unreachable/design-system";
import { UPDATE_JOURNAL_COMMAND, rollingBackWording } from "./update-wording.ts";

/** An update while it runs, as the card and the dialog follow it. */
export interface UpdateProgressState {
  readonly from: string;
  readonly to: string;
  readonly phase: UpdatePhase;
  /** The service went away and answered again: the update helper is now checking the new release. */
  readonly cameBack: boolean;
  /** The service didn't answer again in time. */
  readonly gaveUp: boolean;
}

interface Step {
  /** Not reached yet. */
  readonly todo: string;
  /** Under way; also what the live region announces. */
  readonly now: string;
  readonly done: string;
  readonly detail?: string;
}

function stepsOf(from: string, to: string, rollingBack: boolean): Step[] {
  const first: Step[] = [
    { todo: "Download", now: "Downloading…", done: "Downloaded", detail: "From GitHub" },
    {
      todo: "Check the signature",
      now: "Checking the signature…",
      done: "Signature checked",
      detail: "Signed with NotUnreachable's release key",
    },
  ];
  const install: Step = { todo: "Install", now: `Installing ${to}…`, done: "Installed", detail: `${from} is kept to go back to` };
  if (rollingBack) {
    return [
      ...first,
      // It may not have installed: it doesn't say so.
      { ...install, done: rollingBackWording.installed(to) },
      {
        todo: `Go back to ${from}`,
        now: `Going back to ${from}…`,
        done: `Back on ${from}`,
        detail: rollingBackWording.wentWrong(to),
      },
    ];
  }
  return [
    ...first,
    install,
    {
      todo: "Restart the service",
      now: "Restarting the service…",
      done: "Restarted",
      detail: "The page may stop answering for a moment",
    },
    { todo: "Checking it works", now: "Checking it works…", done: "Works" },
  ];
}

/** Which step is under way in each phase; once the service is back, `restarting` is the check that it works. */
const stepOfPhase: Record<UpdatePhase, number> = {
  downloading: 0,
  verifying: 1,
  verified: 2,
  installing: 2,
  restarting: 3,
  "rolling-back": 3,
  finished: 5,
};

function currentStep(phase: UpdatePhase, cameBack: boolean): number {
  return phase === "restarting" && cameBack ? 4 : stepOfPhase[phase];
}

export interface UpdateProgressProps {
  readonly state: UpdateProgressState;
  /** Waits for the service again after giving up. */
  readonly onRetry: () => void;
}

/** The steps of an update as an ordered list, the current one announced through a live region. */
export function UpdateProgress({ state, onRetry }: UpdateProgressProps) {
  const steps = stepsOf(state.from, state.to, state.phase === "rolling-back");
  const current = Math.min(currentStep(state.phase, state.cameBack), steps.length);
  const now = steps[current]?.now ?? "Finishing…";
  return (
    <div className="flex flex-col gap-4">
      <ProgressBar size="sm" label="Update progress" value={current + 0.5} max={steps.length} valueText={now} />
      <ol className="m-0 flex list-none flex-col p-0">
        {steps.map((step, index) => {
          const done = index < current;
          const isNow = index === current;
          return (
            <li key={step.todo} className="flex gap-3">
              <span aria-hidden="true" className="flex flex-none flex-col items-center">
                <span
                  className={cn(
                    "grid size-6 place-items-center rounded-full border-2 border-solid",
                    done && "border-success bg-success text-fg-on-accent",
                    isNow && "border-accent border-r-transparent bg-surface motion-safe:animate-spin",
                    !done && !isNow && "border-border-strong bg-surface",
                  )}
                >
                  {done && <Icon name="check" size={14} />}
                </span>
                {index < steps.length - 1 && <span className={cn("my-0.5 w-0.5 flex-1", done ? "bg-success" : "bg-border-subtle")} />}
              </span>
              <div className="pb-3.5">
                <div className={cn("type-label", done || isNow ? "text-fg-1" : "font-normal text-fg-3")}>
                  <span className="sr-only">{done ? "Done: " : isNow ? "Now: " : "Next: "}</span>
                  {done ? step.done : isNow ? step.now : step.todo}
                </div>
                {(done || isNow) && step.detail !== undefined && <div className="type-body-sm text-fg-3">{step.detail}</div>}
              </div>
            </li>
          );
        })}
      </ol>
      <output className="sr-only">{state.gaveUp ? "The service didn't come back" : now}</output>
      {state.gaveUp && (
        <Alert
          tone="danger"
          title="The service didn't come back"
          action={
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Retry
            </Button>
          }
        >
          <div className="mt-1 flex flex-col gap-2">
            <p className="m-0">Check it on the server:</p>
            <CopyField what="command" value={UPDATE_JOURNAL_COMMAND} />
          </div>
        </Alert>
      )}
    </div>
  );
}
