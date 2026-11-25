import { problemTypes, routes, shareLinkPath, type Entry, type PublicShareLink } from "@not-unreachable/contracts";
import {
  Alert,
  Breadcrumbs,
  Button,
  ButtonLink,
  Card,
  DataTable,
  DescriptionList,
  EmptyState,
  Icon,
  PasswordInput,
  PublicLayout,
  type DataTableColumn,
} from "@not-unreachable/design-system";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type * as React from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ApiError, api, buildPath, buildQuery } from "../api/index.ts";
import {
  browserNavigation,
  errorProp,
  folderHref,
  formatBytes,
  formatDateTime,
  formatRelative,
  iconOf,
  isProblem,
  joinPath,
  segmentsOf,
} from "../lib/index.ts";
import { useSession } from "../session/index.ts";

/*
 * `/s/:token`: the public share page (threat model, T8). A chunk of its own that imports nothing of
 * the admin's or a user's interface: whoever holds the link sees only the shared item's own name,
 * its size and its expiry, never the resource or the path it is in.
 */

const shareQueryKey = (token: string) => ["share", token] as const;

/** The download URL of the link's file, or of a file inside its folder: a plain GET the browser handles, Range and resume included. */
function shareContentUrl(token: string, path: string): string {
  return buildPath(routes.downloadShareLinkContent.path, { token }) + buildQuery(path === "" ? {} : { path });
}

/** An unknown, malformed, expired or revoked link all answer the same 404 (T1, T8). */
function isInvalidLink(error: unknown): boolean {
  return isProblem(error, problemTypes.shareLinkInvalid) || (error instanceof ApiError && error.status === 404);
}

/** The link's access turned this visitor away: not signed in, or not one of the people it was shared with. */
function isAccessRefused(error: unknown): boolean {
  return isProblem(error, problemTypes.shareLinkSignInRequired) || isProblem(error, problemTypes.shareLinkNotAllowed);
}

function isTooMany(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 429;
}

/** "about 15 minutes", "a minute": how long a Retry-After asks to wait. */
function waitOf(seconds: number | undefined): string {
  if (seconds === undefined) return "a few minutes";
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 1 ? "a minute" : `${minutes} minutes`;
}

function tooManyMessage(error: ApiError): string {
  if (error.type === problemTypes.tooManyAttempts) {
    return `Too many wrong passwords. The link is locked for now: try again in ${waitOf(error.retryAfterSeconds)}.`;
  }
  if (error.type === problemTypes.tooManyDownloads) return "Too many downloads of this link are running from here. Wait for one to finish.";
  return `Too many requests from your network. Try again in ${waitOf(error.retryAfterSeconds)}.`;
}

function InvalidLink() {
  return (
    <PublicLayout>
      <Alert tone="warning" title="This link is not valid" className="w-full max-w-120">
        It may have expired or been revoked. Ask whoever sent it for a new one.
      </Alert>
    </PublicLayout>
  );
}

/** A "Signed-in users" or "Selected users" link opened signed out; sign-in comes back here. */
function SignInRequired({ token }: { readonly token: string }) {
  return (
    <PublicLayout>
      <Alert
        tone="info"
        title="Sign in to open this link"
        className="w-full max-w-120"
        action={
          <ButtonLink size="sm" href={`/sign-in?next=${encodeURIComponent(shareLinkPath(token))}`}>
            Sign in
          </ButtonLink>
        }
      >
        Only people with an account here can open it.
      </Alert>
    </PublicLayout>
  );
}

/**
 * A "Selected users" link opened by someone not on its list. Signing out loads /sign-in afresh, as
 * the account menu's Sign out does, coming back here once signed in with another account.
 */
function NotAllowed({ token }: { readonly token: string }) {
  const { data: session } = useSession();
  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    setFailed(false);
    try {
      await api("signOut");
    } catch (error) {
      // 401: the session had already ended, which is what signing out wanted.
      if (!(error instanceof ApiError && error.status === 401)) {
        setSigningOut(false);
        setFailed(true);
        return;
      }
    }
    browserNavigation.replace(`/sign-in?next=${encodeURIComponent(shareLinkPath(token))}`);
  };

  return (
    <PublicLayout>
      <Alert
        tone="warning"
        title="This link was shared with other people"
        className="w-full max-w-120"
        action={
          <Button variant="secondary" size="sm" loading={signingOut} onClick={() => void signOut()}>
            Sign out
          </Button>
        }
      >
        {session?.state === "active" ? `You're signed in as ${session.account.username}. ` : ""}
        Sign in with another account, or ask whoever sent it to share it with you.
        {failed && " Signing out did not work. Try again."}
      </Alert>
    </PublicLayout>
  );
}

function expiryText(link: PublicShareLink): string {
  return link.expiresAt === null ? "Never" : formatDateTime(link.expiresAt);
}

export function Component() {
  const { token = "" } = useParams();
  const info = useQuery({
    queryKey: shareQueryKey(token),
    queryFn: ({ signal }) => api("getPublicShareLink", { params: { token }, signal }),
  });

  if (info.isPending) return <PublicLayout />;
  if (info.isError) {
    if (isInvalidLink(info.error)) return <InvalidLink />;
    if (isProblem(info.error, problemTypes.shareLinkSignInRequired)) return <SignInRequired token={token} />;
    if (isProblem(info.error, problemTypes.shareLinkNotAllowed)) return <NotAllowed token={token} />;
    return (
      <PublicLayout>
        <Alert
          tone="danger"
          title="This link could not be opened"
          className="w-full max-w-120"
          action={
            <Button variant="secondary" size="sm" onClick={() => void info.refetch()}>
              Try again
            </Button>
          }
        >
          {isTooMany(info.error) ? tooManyMessage(info.error) : "Reload the page to try again."}
        </Alert>
      </PublicLayout>
    );
  }

  const link = info.data;
  return (
    <PublicLayout>
      {link.passwordRequired ? (
        <UnlockCard token={token} link={link} />
      ) : link.kind === "file" ? (
        <FileCard token={token} link={link} />
      ) : (
        <FolderView token={token} link={link} />
      )}
    </PublicLayout>
  );
}

interface LinkViewProps {
  readonly token: string;
  readonly link: PublicShareLink;
}

function ItemTitle({ link }: { readonly link: PublicShareLink }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className={link.kind === "folder" ? "grid text-accent" : "grid text-fg-3"}>
        <Icon name={iconOf(link.kind, link.name)} size={16} />
      </span>
      <span className="truncate">{link.name}</span>
    </span>
  );
}

function details(link: PublicShareLink) {
  return [...(link.size === null ? [] : [{ label: "Size", value: formatBytes(link.size) }]), { label: "Expires", value: expiryText(link) }];
}

function UnlockCard({ token, link }: LinkViewProps) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const unlock = useMutation({
    mutationFn: (typed: string) => api("unlockShareLink", { params: { token }, body: { password: typed } }),
    // The unlock cookie is set: the link answers again, without the password asked for.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: shareQueryKey(token) }),
    onError: (failure) => {
      if (isInvalidLink(failure) || isAccessRefused(failure)) void queryClient.invalidateQueries({ queryKey: shareQueryKey(token) });
      else if (isProblem(failure, problemTypes.shareLinkPasswordWrong)) setError("The password is wrong.");
      else setError(undefined);
    },
  });

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password === "") {
      setError("Enter the password.");
      return;
    }
    setError(undefined);
    unlock.mutate(password);
  };

  const otherFailure =
    unlock.isError &&
    !isProblem(unlock.error, problemTypes.shareLinkPasswordWrong) &&
    !isInvalidLink(unlock.error) &&
    !isAccessRefused(unlock.error)
      ? unlock.error
      : null;

  return (
    <Card title={<ItemTitle link={link} />} subtitle="This link needs a password." className="w-full max-w-120">
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        {otherFailure !== null && (
          <Alert tone="danger">{isTooMany(otherFailure) ? tooManyMessage(otherFailure) : "That did not work. Try again."}</Alert>
        )}
        <PasswordInput
          label="Password"
          autoComplete="off"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          {...errorProp(error)}
        />
        <Button type="submit" loading={unlock.isPending} iconLeft={<Icon name="lock" size={14} />} className="self-start">
          Unlock
        </Button>
        <DescriptionList items={details(link)} />
      </form>
    </Card>
  );
}

function FileCard({ token, link }: LinkViewProps) {
  return (
    <Card title={<ItemTitle link={link} />} subtitle="Shared with you" className="w-full max-w-120">
      <div className="flex flex-col gap-4">
        <DescriptionList items={details(link)} />
        <ButtonLink
          href={shareContentUrl(token, "")}
          download={link.name}
          iconLeft={<Icon name="download" size={14} />}
          className="self-start"
        >
          Download
        </ButtonLink>
      </div>
    </Card>
  );
}

function FolderView({ token, link }: LinkViewProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search] = useSearchParams();
  const path = search.get("path") ?? "";
  const segments = segmentsOf(path);
  const page = `/s/${encodeURIComponent(token)}`;
  const hrefOf = (folder: string) => folderHref(page, folder);

  const listing = useInfiniteQuery({
    queryKey: [...shareQueryKey(token), "entries", path],
    queryFn: ({ pageParam, signal }) =>
      api("listShareLinkEntries", {
        params: { token },
        query: { path, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (entriesPage) => entriesPage.nextCursor ?? undefined,
  });

  // The unlock ran out, the link stopped working, or the session ended or changed: ask the link
  // again, which says which.
  const lost =
    listing.isError &&
    (isProblem(listing.error, problemTypes.shareLinkPasswordRequired) ||
      isProblem(listing.error, problemTypes.shareLinkInvalid) ||
      isAccessRefused(listing.error));
  useEffect(() => {
    if (lost) void queryClient.invalidateQueries({ queryKey: shareQueryKey(token), exact: true });
  }, [lost, queryClient, token]);

  const entries = (listing.data?.pages.flatMap((entriesPage) => entriesPage.entries) ?? []).filter(
    (entry) => entry.kind === "file" || entry.kind === "folder",
  );

  const columns: DataTableColumn<Entry>[] = [
    {
      key: "name",
      header: "Name",
      render: (entry) => {
        const entryPath = joinPath(path, entry.name);
        return (
          <span className="flex min-w-0 items-center gap-2.5">
            <span className={entry.kind === "folder" ? "grid text-accent" : "grid text-fg-3"}>
              <Icon name={iconOf(entry.kind, entry.name)} size={16} />
            </span>
            {entry.kind === "folder" ? (
              <Link to={hrefOf(entryPath)} className="min-w-0 truncate font-medium text-fg-1 no-underline hover:text-link hover:underline">
                {entry.name}
              </Link>
            ) : (
              // Only its name: Download is the row's own button.
              <span className="min-w-0 truncate text-fg-1">{entry.name}</span>
            )}
          </span>
        );
      },
    },
    {
      key: "size",
      header: "Size",
      align: "right",
      width: 120,
      muted: true,
      render: (entry) => (entry.kind === "file" ? formatBytes(entry.size) : "—"),
    },
    {
      key: "modifiedAt",
      header: "Modified",
      width: 160,
      muted: true,
      render: (entry) => (
        <time dateTime={entry.modifiedAt} title={formatDateTime(entry.modifiedAt)}>
          {formatRelative(entry.modifiedAt)}
        </time>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      width: 120,
      render: (entry) =>
        entry.kind === "file" ? (
          <ButtonLink
            href={shareContentUrl(token, joinPath(path, entry.name))}
            download={entry.name}
            variant="secondary"
            size="sm"
            aria-label={`Download ${entry.name}`}
            iconLeft={<Icon name="download" size={14} />}
          >
            Download
          </ButtonLink>
        ) : null,
    },
  ];

  return (
    <div className="flex w-full flex-col gap-4">
      <Card title={<ItemTitle link={link} />} subtitle="A shared folder">
        <DescriptionList items={details(link)} />
      </Card>

      {segments.length > 0 && (
        <Breadcrumbs
          items={[
            { label: link.name, href: hrefOf(""), onClick: () => void navigate(hrefOf("")) },
            ...segments.map((segment, index) => {
              const crumbPath = segments.slice(0, index + 1).join("/");
              return { label: segment, href: hrefOf(crumbPath), onClick: () => void navigate(hrefOf(crumbPath)) };
            }),
          ]}
        />
      )}

      <Card padding="none">
        {listing.isPending || lost ? (
          <p className="m-0 p-5 type-body-sm text-fg-3">Loading files…</p>
        ) : listing.isError ? (
          <div className="p-5">
            {isProblem(listing.error, problemTypes.notFound) ? (
              <Alert
                tone="warning"
                title="This folder doesn't exist"
                action={
                  <Button variant="secondary" size="sm" onClick={() => void navigate(hrefOf(""))}>
                    Go to the top folder
                  </Button>
                }
              >
                It may have been deleted or renamed.
              </Alert>
            ) : (
              <Alert
                tone="danger"
                title="Files could not be loaded"
                action={
                  <Button variant="secondary" size="sm" onClick={() => void listing.refetch()}>
                    Try again
                  </Button>
                }
              >
                {isTooMany(listing.error) ? tooManyMessage(listing.error) : "Reload the page to try again."}
              </Alert>
            )}
          </div>
        ) : (
          <>
            <DataTable
              caption={segments.length === 0 ? link.name : `${link.name} / ${segments.join(" / ")}`}
              columns={columns}
              rows={entries}
              rowKey={(entry) => entry.name}
              empty={<EmptyState icon="folder-open" title="This folder is empty" description="There is nothing to download here." />}
            />
            {listing.hasNextPage && (
              <div className="flex justify-center border-t border-solid border-border-subtle p-3">
                <Button variant="secondary" size="sm" loading={listing.isFetchingNextPage} onClick={() => void listing.fetchNextPage()}>
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
