import type { LatestRelease, Update, UpdateResult, UpdatesOverview } from "@not-unreachable/contracts";
import { Alert, Badge, Button, Card, Icon, cn, useToast, type IconName } from "@not-unreachable/design-system";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type * as React from "react";
import { ApiError, api } from "../api/index.ts";
import { SettingsRow } from "../layout/index.ts";
import { formatDate, formatDateTime, formatLongDate, formatRelative, formatTime, problemMessage } from "../lib/index.ts";
import { isDroppedConnection } from "./reauthentication.tsx";
import { useServiceComeback, type ServiceWaitTiming } from "./service-restart.ts";
import { FollowUp, InstallElsewhere, ServerCommand } from "./update-commands.tsx";
import { UpdateInstallDialog } from "./update-install-dialog.tsx";
import { UpdateProgress, type UpdateProgressState } from "./update-progress.tsx";
import {
  ALL_RELEASES_URL,
  REQUEST_LOST_WORDING,
  canTryAgain,
  notInstallableWording,
  resultBadge,
  resultTitle,
  resultWording,
} from "./update-wording.ts";

export const updatesQueryKey = ["admin", "settings", "updates"] as const;

/**
 * How the tab follows an update, in milliseconds: it reads the overview while the server answers;
 * once it stops answering, it checks `/api/v1/health` until the service is back (any answer then is
 * the new process, as one has already failed), and gives up after 10 minutes. An install request
 * whose answer was lost may not have reached the server: once the server has answered for
 * `requestLostMs` with no new update, the tab stops following it. Tests shorten these.
 */
export const updateTiming: ServiceWaitTiming & { pollEveryMs: number; requestLostMs: number } = {
  pollEveryMs: 2000,
  requestLostMs: 15_000,
  firstCheckMs: 1000,
  checkEveryMs: 2000,
  checkTimeoutMs: 6000,
  settleMs: 0,
  giveUpMs: 10 * 60_000,
};

const allReleases = new URL(ALL_RELEASES_URL);

/** Release notes open only on this repository's releases; any other address links to them all. */
function releaseNotesHref(url: string): string {
  if (!URL.canParse(url)) return ALL_RELEASES_URL;
  const parsed = new URL(url);
  const onReleases =
    parsed.origin === allReleases.origin &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname.startsWith(`${allReleases.pathname}/`) &&
    // Written as it parses, so no `..`, encoded part or other spelling leads elsewhere.
    parsed.href === url &&
    !parsed.pathname.split("/").includes("..");
  return onReleases ? parsed.href : ALL_RELEASES_URL;
}

/** The update this tab follows: the one asked for here, or one that was running when the tab opened. */
interface Following {
  /** The release being installed. */
  readonly version: string;
  /** Its request id; null when the service went away before answering the request. */
  readonly requestId: string | null;
  /** The last update's id when this one was asked for, to tell the new one apart without its id. */
  readonly previous: string | null;
}

function isRunning(overview: UpdatesOverview | undefined): boolean {
  return overview?.update != null && overview.update.phase !== "finished";
}

function isFollowed(update: Update, following: Following): boolean {
  return following.requestId === null ? update.requestId !== following.previous : update.requestId === following.requestId;
}

/** Whether the latest release is newer than this server's, installable from here or not. */
function isNewer(latest: LatestRelease): boolean {
  return latest.installable || (latest.notInstallableBecause !== null && latest.notInstallableBecause !== "not-newer");
}

type FailedUpdate = Update & { readonly result: Exclude<UpdateResult, "succeeded"> };

function isFailed(update: Update): update is FailedUpdate {
  return update.result !== null && update.result !== "succeeded";
}

function ExternalLink({ href, children }: { readonly href: string; readonly children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 type-body">
      {children}
      <Icon name="external-link" size={14} />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function ReleaseNotesLink({ latest }: { readonly latest: LatestRelease }) {
  return <ExternalLink href={releaseNotesHref(latest.releaseNotesUrl)}>Release notes</ExternalLink>;
}

type HeroTone = "accent" | "success" | "neutral" | "danger";

const heroToneClasses: Record<HeroTone, string> = {
  accent: "bg-accent-subtle text-accent-subtle-fg",
  success: "bg-success-subtle text-success-fg",
  neutral: "bg-surface-sunken text-fg-2",
  danger: "bg-danger-subtle text-danger-fg",
};

interface HeroProps {
  readonly icon: IconName;
  readonly tone: HeroTone;
  readonly title: string;
  readonly titleRef: React.Ref<HTMLHeadingElement>;
  readonly text: React.ReactNode;
  readonly actions?: React.ReactNode;
  /** Under the title and text, the width of the card: a note, an alert, the steps. */
  readonly children?: React.ReactNode;
}

/** The card that answers "am I up to date?", with the one action that matters. */
function Hero({ icon, tone, title, titleRef, text, actions, children }: HeroProps) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col rounded-card border border-solid border-border bg-surface">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
        <span className={cn("grid size-10 flex-none place-items-center rounded-card", heroToneClasses[tone])}>
          <Icon name={icon} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          {/* Focused when an update ends, so its result is read out. */}
          <h3 id={titleId} ref={titleRef} tabIndex={-1} className="m-0 type-section-title text-fg-1 outline-none">
            {title}
          </h3>
          <div className="mt-1 type-body text-fg-2">{text}</div>
        </div>
        {actions != null && <div className="flex flex-none flex-wrap items-center gap-3">{actions}</div>}
      </div>
      {children != null && <div className="px-5 pb-5">{children}</div>}
    </section>
  );
}

/** "12 minutes ago" with the exact local time beside it, as the audit log shows times. */
function When({ iso }: { readonly iso: string }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-2">
      <span className="type-body text-fg-1">{formatRelative(iso)}</span>
      <time dateTime={iso} className="type-mono text-fg-3">
        {formatDateTime(iso)}
      </time>
    </span>
  );
}

const resultIcon: Record<Exclude<UpdateResult, "succeeded">, IconName> = {
  refused: "shield",
  "rolled-back": "undo-2",
  "rollback-failed": "triangle-alert",
  interrupted: "triangle-alert",
};

/** Admin settings → Updates: the running release, the latest one, and installing it from here. */
export function UpdatesSettings() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [following, setFollowing] = useState<Following | null>(null);
  // The service answered again after going away: the update helper now checks the new release.
  const [cameBack, setCameBack] = useState(false);
  // When the wait that gave up began, so a later wait starts afresh.
  const [gaveUpSince, setGaveUpSince] = useState<number | null>(null);
  // Stays mounted once opened, so closing it returns the focus; the key gives each opening a fresh one.
  const [dialog, setDialog] = useState<{ readonly key: number; readonly version: string; readonly open: boolean } | null>(null);
  const [seen, setSeen] = useState<UpdatesOverview | undefined>(undefined);
  const [finished, setFinished] = useState<Update | null>(null);
  // The install asked for here never reached the server.
  const [requestLost, setRequestLost] = useState(false);
  const heroTitle = useRef<HTMLHeadingElement>(null);
  const openings = useRef(0);

  const query = useQuery({
    queryKey: updatesQueryKey,
    queryFn: ({ signal }) => api("getUpdates", { signal }),
    // Every 2 s while an update runs and the server answers; the health checks take over while it doesn't.
    refetchInterval: ({ state }) =>
      (following !== null || isRunning(state.data)) && !(state.status === "error" && isDroppedConnection(state.error))
        ? updateTiming.pollEveryMs
        : false,
    // While an update runs, no answer is the restart: the health checks wait for it instead of a retry.
    retry: (failures, error) =>
      !(following !== null && isDroppedConnection(error)) && failures < 1 && !(error instanceof ApiError && error.status < 500),
  });
  const overview = query.data;

  // The service went away under the update, since its last answer failed.
  const awaySince = following !== null && query.isError && isDroppedConnection(query.error) ? query.errorUpdatedAt : null;
  const gaveUp = awaySince !== null && gaveUpSince === awaySince;

  useServiceComeback(
    gaveUp ? null : awaySince,
    updateTiming,
    () => {
      setCameBack(true);
      void query.refetch();
    },
    () => setGaveUpSince(awaySince),
  );

  // Asked for without an answer, and the server answers with no new update: once it has for a
  // while, the request never reached it (the 10-minute give-up counts only while it doesn't answer).
  const awaitingRequest =
    following !== null &&
    following.requestId === null &&
    awaySince === null &&
    !(overview?.update != null && isFollowed(overview.update, following));
  useEffect(() => {
    if (!awaitingRequest) return undefined;
    const timer = setTimeout(() => {
      setFollowing(null);
      setCameBack(false);
      setDialog((opened) => (opened === null ? null : { ...opened, open: false }));
      setRequestLost(true);
    }, updateTiming.requestLostMs);
    return () => clearTimeout(timer);
  }, [awaitingRequest]);

  // Read out from the hero's title, as a result is.
  useEffect(() => {
    if (requestLost) heroTitle.current?.focus();
  }, [requestLost]);

  // Follows an update that runs, and stops once the one followed has finished.
  if (overview !== seen) {
    setSeen(overview);
    const update = overview?.update ?? null;
    if (update !== null && following === null && update.phase !== "finished") {
      setFollowing({ version: update.to, requestId: update.requestId, previous: null });
      setRequestLost(false);
    } else if (update !== null && following !== null && update.phase === "finished" && isFollowed(update, following)) {
      setFollowing(null);
      setCameBack(false);
      setGaveUpSince(null);
      setDialog((opened) => (opened === null ? null : { ...opened, open: false }));
      setFinished(update);
    }
  }

  // The result is read out from the hero's title.
  useEffect(() => {
    if (finished === null) return;
    heroTitle.current?.focus();
    if (finished.result === "succeeded") toast.show({ tone: "success", title: `Updated to ${finished.to}` });
  }, [finished, toast]);

  const check = useMutation({
    mutationFn: () => api("checkForUpdates"),
    onSuccess: (checked) => {
      queryClient.setQueryData(updatesQueryKey, checked);
      if (checked.check.enabled && checked.check.failedAt !== null) toast.show({ tone: "warning", title: "GitHub couldn't be reached" });
      else toast.show({ tone: "success", title: "Checked for updates" });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 429) {
        toast.show({ tone: "warning", title: "You checked a moment ago. Try again in a minute." });
        return;
      }
      // Checking was turned off meanwhile: the overview says so.
      if (error instanceof ApiError && error.status === 404) void queryClient.invalidateQueries({ queryKey: updatesQueryKey });
      toast.show({ tone: "danger", title: "Checking did not work", description: problemMessage(error, "Try again.") });
    },
  });

  if (query.isPending) return <p className="m-0 type-body-sm text-fg-3">Loading updates…</p>;
  if (overview === undefined) {
    return (
      <Alert
        tone="danger"
        title="Updates could not be loaded"
        action={
          <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      >
        {problemMessage(query.error, "Reload the page to try again.")}
      </Alert>
    );
  }

  const current = overview.current.version;
  const update = overview.update;
  const latest = overview.check.enabled ? overview.check.latest : null;
  const canInstall = overview.install.enabled && latest !== null && latest.installable;

  let progress: UpdateProgressState | null = null;
  if (update !== null && update.phase !== "finished" && (following === null || isFollowed(update, following))) {
    progress = { from: update.from, to: update.to, phase: update.phase, cameBack, gaveUp };
  } else if (following !== null && (update === null || !isFollowed(update, following))) {
    // Asked for, and not in the overview yet.
    progress = { from: current, to: following.version, phase: "downloading", cameBack, gaveUp };
  }

  const openInstall = (version: string) => {
    openings.current += 1;
    setDialog({ key: openings.current, version, open: true });
    setRequestLost(false);
  };

  // Asks again: no answer starts a new wait.
  const retryWait = () => void query.refetch();

  const checkNow = (
    <Button
      variant="secondary"
      size="sm"
      iconLeft={<Icon name="refresh-cw" size={14} />}
      loading={check.isPending}
      onClick={() => check.mutate()}
    >
      Check now
    </Button>
  );

  const installButton = (release: LatestRelease) =>
    overview.install.enabled ? (
      <Button disabled={!release.installable} onClick={() => openInstall(release.version)}>
        Install {release.version}
      </Button>
    ) : null;

  const failed = update !== null && progress === null && isFailed(update) && update.from === current ? update : null;
  let hero: React.ReactNode;
  let checkInHero = false;
  if (progress !== null) {
    hero = (
      <Hero
        icon="arrow-up"
        tone="accent"
        title={`Installing ${progress.to}`}
        titleRef={heroTitle}
        text="This takes about a minute. The page may stop answering for a moment."
      >
        <UpdateProgress state={progress} onRetry={retryWait} />
      </Hero>
    );
  } else if (failed !== null) {
    const wording = resultWording(failed);
    const retryable = canInstall && canTryAgain(failed);
    hero = (
      <Hero
        icon={resultIcon[failed.result]}
        tone="danger"
        title={resultTitle(failed.result, failed.to)}
        titleRef={heroTitle}
        text={wording.text}
        actions={
          retryable ? (
            <Button variant="secondary" size="sm" onClick={() => openInstall(latest.version)}>
              Try again
            </Button>
          ) : undefined
        }
      >
        {wording.followUp === null ? null : <FollowUp followUp={wording.followUp} install={overview.install} />}
      </Hero>
    );
  } else if (!overview.check.enabled) {
    hero = (
      <Hero
        icon="circle-off"
        tone="neutral"
        title={`This server runs ${current}`}
        titleRef={heroTitle}
        text="Checking for new releases is turned off on this server, so nothing is asked of GitHub. See the releases on GitHub and install over SSH."
        actions={<ExternalLink href={ALL_RELEASES_URL}>All releases</ExternalLink>}
      />
    );
  } else if (latest === null) {
    checkInHero = true;
    hero = (
      <Hero
        icon="refresh-cw"
        tone="neutral"
        title={`This server runs ${current}`}
        titleRef={heroTitle}
        text={
          overview.check.failedAt === null
            ? "It hasn't heard from GitHub about new releases yet. The server checks every 6 hours."
            : "GitHub couldn't be reached, so the latest release isn't known yet. The server tries again in 6 hours."
        }
        actions={checkNow}
      />
    );
  } else if (isNewer(latest)) {
    const notInstallable =
      latest.notInstallableBecause === "unsigned" || latest.notInstallableBecause === "no-tarball" ? latest.notInstallableBecause : null;
    hero = (
      <Hero
        icon="arrow-up"
        tone="accent"
        title={`NotUnreachable ${latest.version} is available`}
        titleRef={heroTitle}
        text={`You run ${current}. Released on ${formatLongDate(latest.publishedAt)}.`}
        actions={
          <>
            <ReleaseNotesLink latest={latest} />
            {installButton(latest)}
          </>
        }
      >
        {requestLost && (
          <Alert tone="danger" title={REQUEST_LOST_WORDING.title} className="mb-3">
            {REQUEST_LOST_WORDING.text}
          </Alert>
        )}
        {notInstallable !== null ? (
          <Alert tone="neutral">
            <div className="flex flex-col gap-3">
              <p className="m-0">{notInstallableWording[notInstallable]}</p>
              <ServerCommand label="Install over SSH" value={overview.install.installerCommand} />
            </div>
          </Alert>
        ) : overview.install.enabled ? (
          <p className="m-0 rounded-control bg-surface-sunken px-3 py-2.5 type-body-sm text-fg-2">
            Installing restarts the service, which takes about a minute. Everyone signed in stays signed in, and uploads in progress pick up
            where they stopped. If {latest.version} doesn't start properly, the server goes back to {current} and its data by itself.
          </p>
        ) : (
          <InstallElsewhere install={overview.install} />
        )}
      </Hero>
    );
  } else {
    checkInHero = true;
    const { checkedAt } = overview.check;
    hero = (
      <Hero
        icon="circle-check"
        tone="success"
        title="You're up to date"
        titleRef={heroTitle}
        text={`${latest.version} is the latest release.${checkedAt === null ? "" : ` Checked ${formatRelative(checkedAt)}.`}`}
        actions={checkNow}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {hero}
      <Card title="Version" padding="none" bodyClassName="px-5">
        <SettingsRow label="This server" description="The release this instance runs.">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="type-mono text-fg-1">{current}</span>
            {latest !== null && isNewer(latest) && <Badge tone="warning">Update available</Badge>}
          </div>
        </SettingsRow>
        {overview.check.enabled && (
          <>
            <SettingsRow label="Latest release" description="From GitHub. Only signed releases can be installed.">
              {latest === null ? (
                <span className="type-body text-fg-3">Not known yet</span>
              ) : (
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="type-mono text-fg-1">{latest.version}</span>
                  <span className="type-body-sm text-fg-3">
                    {overview.check.failedAt !== null && overview.check.checkedAt !== null
                      ? `as of ${formatDateTime(overview.check.checkedAt)}`
                      : formatDate(latest.publishedAt)}
                  </span>
                  <ReleaseNotesLink latest={latest} />
                </div>
              )}
            </SettingsRow>
            <SettingsRow label="Last checked" description="Checked every 6 hours. Nothing that identifies this server is sent.">
              <div className="flex flex-col gap-3">
                {overview.check.failedAt !== null && (
                  <Alert tone="warning" title={`GitHub couldn't be reached at ${formatTime(overview.check.failedAt)}`}>
                    {overview.check.checkedAt === null
                      ? "The server tries again in 6 hours."
                      : `This shows the last answer, from ${formatTime(overview.check.checkedAt)}. The server tries again in 6 hours.`}
                  </Alert>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  {overview.check.checkedAt === null ? (
                    <span className="type-body text-fg-3">Not yet</span>
                  ) : (
                    <When iso={overview.check.checkedAt} />
                  )}
                  {!checkInHero && progress === null && <div className="ml-auto">{checkNow}</div>}
                </div>
              </div>
            </SettingsRow>
          </>
        )}
        {update !== null && update.result !== null && update.finishedAt !== null && progress === null && (
          <SettingsRow label="Last update" description="The last install from here.">
            <div className="flex flex-wrap items-center gap-2.5">
              <Badge tone={update.result === "succeeded" ? "success" : "danger"} dot>
                {resultBadge[update.result]}
              </Badge>
              <span className="type-body text-fg-1">
                <span className="type-mono">{update.from}</span> → <span className="type-mono">{update.to}</span>
              </span>
              <time dateTime={update.finishedAt} className="type-mono text-fg-3">
                {formatDateTime(update.finishedAt)}
              </time>
            </div>
          </SettingsRow>
        )}
      </Card>
      {dialog !== null && (
        <UpdateInstallDialog
          key={dialog.key}
          open={dialog.open}
          version={dialog.version}
          current={current}
          install={overview.install}
          progress={progress}
          onClose={() => setDialog({ ...dialog, open: false })}
          onRequested={(requestId) => {
            setFollowing({ version: dialog.version, requestId, previous: update?.requestId ?? null });
            setCameBack(false);
            void query.refetch();
          }}
          onStale={() => void queryClient.invalidateQueries({ queryKey: updatesQueryKey })}
          onRetry={retryWait}
        />
      )}
    </div>
  );
}
