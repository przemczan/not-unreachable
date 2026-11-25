import { problemMediaType, problemTypes, type EntriesPage, type PublicShareLink } from "@not-unreachable/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { browserNavigation } from "../lib/index.ts";
import { baseHandlers, json, noContent, problem, renderApp, requestsTo, stubApi, userSession, type MockHandler } from "../testing/index.ts";

const token = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const base = `/api/v1/public/share-links/${token}`;
const expiresAt = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
const modifiedAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();

const file: PublicShareLink = { name: "report.pdf", kind: "file", size: 2_500_000, expiresAt, passwordRequired: false };
const folder: PublicShareLink = { name: "Photos", kind: "folder", size: null, expiresAt: null, passwordRequired: false };

function folderEntries({ url }: { readonly url: URL }): Response {
  const path = url.searchParams.get("path") ?? "";
  const page: EntriesPage =
    path === "2026"
      ? { path, entries: [{ name: "beach.jpg", kind: "file", size: 4_000_000, modifiedAt }], nextCursor: null }
      : {
          path: "",
          entries: [
            { name: "2026", kind: "folder", size: 0, modifiedAt },
            { name: "cover.png", kind: "file", size: 1_200, modifiedAt },
          ],
          nextCursor: null,
        };
  return json(200, page);
}

const signInRequired = () => problem(401, problemTypes.shareLinkSignInRequired, "Sign in to open this link");
const notAllowed = () => problem(403, problemTypes.shareLinkNotAllowed, "This link is not shared with you");
const signInHref = `/sign-in?next=${encodeURIComponent(`/s/${token}`)}`;

/** The public page needs only the share API's routes: everything else answers 404. */
function only(handlers: Record<string, MockHandler>) {
  return stubApi(handlers);
}

describe("public share page", () => {
  it("shows a file link's name, size and expiry, and downloads it with a plain link", async () => {
    const fetchMock = only({ [`GET ${base}`]: () => json(200, file) });
    renderApp(`/s/${token}`);

    expect(await screen.findByText("report.pdf")).toBeDefined();
    expect(screen.getByText("2.5 MB")).toBeDefined();
    expect(
      screen.getByText(new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(expiresAt))),
    ).toBeDefined();
    const download = screen.getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toBe(`${base}/content`);
    expect(download.getAttribute("download")).toBe("report.pdf");
    // PublicLayout: the Logo only, no navigation; no admin or setup request (the app asks for its session, which is all).
    expect(screen.queryByRole("navigation")).toBeNull();
    const urls = fetchMock.mock.calls.map(([input]) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url));
    const paths = new Set(urls.map((url) => new URL(url, "http://localhost").pathname));
    expect([...paths].toSorted()).toEqual(["/api/v1/session", base].toSorted());
  });

  it("asks for the password, unlocks, then continues to the download", async () => {
    let unlocked = false;
    const fetchMock = only({
      [`GET ${base}`]: () => json(200, { ...file, passwordRequired: !unlocked }),
      [`POST ${base}/unlock`]: ({ body }) => {
        if (typeof body === "object" && body !== null && "password" in body && body.password === "right password") {
          unlocked = true;
          return noContent();
        }
        return problem(401, problemTypes.shareLinkPasswordWrong, "Wrong password");
      },
    });
    renderApp(`/s/${token}`);

    expect(await screen.findByText("This link needs a password.")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Download" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("Enter the password.")).toBeDefined();

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong password" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("The password is wrong.")).toBeDefined();

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "right password" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByRole("link", { name: "Download" })).toBeDefined();
    expect(requestsTo(fetchMock, `POST ${base}/unlock`).map((request) => request.body)).toEqual([
      { password: "wrong password" },
      { password: "right password" },
    ]);
  });

  it("says how long to wait while the link is locked after wrong passwords", async () => {
    only({
      [`GET ${base}`]: () => json(200, { ...file, passwordRequired: true }),
      [`POST ${base}/unlock`]: () =>
        new Response(JSON.stringify({ type: problemTypes.tooManyAttempts, title: "Too many attempts", status: 429 }), {
          status: 429,
          headers: { "Content-Type": problemMediaType, "Retry-After": "3540" },
        }),
    });
    renderApp(`/s/${token}`);

    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "a guess" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("Too many wrong passwords. The link is locked for now: try again in 59 minutes.")).toBeDefined();
  });

  it("browses a folder link with Breadcrumbs, each file downloadable", async () => {
    only({ [`GET ${base}`]: () => json(200, folder), [`GET ${base}/entries`]: folderEntries });
    const { router } = renderApp(`/s/${token}`);

    const table = await screen.findByRole("table", { name: "Photos" });
    expect(screen.getByText("Never")).toBeDefined();
    const cover = within(table).getByRole("link", { name: "Download cover.png" });
    expect(cover.getAttribute("href")).toBe(`${base}/content?path=cover.png`);

    fireEvent.click(within(table).getByRole("link", { name: "2026" }));
    const inner = await screen.findByRole("table", { name: "Photos / 2026" });
    expect(router.state.location.search).toBe("?path=2026");
    // A file's name is only text; its Download button downloads it.
    expect(within(inner).queryByRole("link", { name: "beach.jpg" })).toBeNull();
    expect(within(inner).getByRole("link", { name: "Download beach.jpg" }).getAttribute("href")).toBe(
      `${base}/content?path=2026%2Fbeach.jpg`,
    );

    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    fireEvent.click(within(crumbs).getByRole("link", { name: "Photos" }));
    await screen.findByRole("table", { name: "Photos" });
    expect(router.state.location.search).toBe("");
  });

  it.each([
    ["unknown", () => problem(404, problemTypes.shareLinkInvalid, "Not valid")],
    ["any 404", () => problem(404, problemTypes.notFound, "Not found")],
  ])("says the link is not valid for an %s answer", async (_what, answer) => {
    only({ [`GET ${base}`]: answer });
    renderApp(`/s/${token}`);
    expect(await screen.findByText("This link is not valid")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
  });

  it("asks to wait when there are too many requests", async () => {
    only({
      [`GET ${base}`]: () =>
        new Response(JSON.stringify({ type: problemTypes.rateLimited, title: "Rate limited", status: 429 }), {
          status: 429,
          headers: { "Content-Type": problemMediaType, "Retry-After": "900" },
        }),
    });
    renderApp(`/s/${token}`);
    expect(await screen.findByText("Too many requests from your network. Try again in 15 minutes.")).toBeDefined();
  });

  it("asks for the password again when the unlock ran out while browsing", async () => {
    let calls = 0;
    only({
      [`GET ${base}`]: () => {
        calls += 1;
        return json(200, { ...folder, passwordRequired: calls > 1 });
      },
      [`GET ${base}/entries`]: () => problem(401, problemTypes.shareLinkPasswordRequired, "Password required"),
    });
    renderApp(`/s/${token}`);
    expect(await screen.findByText("This link needs a password.")).toBeDefined();
    await waitFor(() => expect(calls).toBe(2));
  });

  it("asks a visitor to sign in to a link for signed-in users, coming back here after", async () => {
    only({ [`GET ${base}`]: signInRequired });
    renderApp(`/s/${token}`);

    expect(await screen.findByText("Sign in to open this link")).toBeDefined();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(signInHref);
    expect(signInHref).toBe(`/sign-in?next=%2Fs%2F${token}`);
    expect(screen.queryByText("report.pdf")).toBeNull();
    expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
  });

  it("tells an account the link wasn't shared with who it is, and signs out to come back", async () => {
    const replace = vi.spyOn(browserNavigation, "replace").mockImplementation(() => undefined);
    const fetchMock = stubApi({
      ...baseHandlers({ session: userSession }),
      [`GET ${base}`]: notAllowed,
      "POST /api/v1/sign-out": () => noContent(),
    });
    renderApp(`/s/${token}`);

    expect(await screen.findByText("This link was shared with other people")).toBeDefined();
    expect(await screen.findByText(/You're signed in as user\./)).toBeDefined();
    expect(screen.queryByText("report.pdf")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(signInHref));
    expect(requestsTo(fetchMock, "POST /api/v1/sign-out")).toHaveLength(1);
  });

  it.each([
    ["signed out while browsing", signInRequired, "Sign in to open this link"],
    ["taken off the list while browsing", notAllowed, "This link was shared with other people"],
  ])("asks the link again when %s", async (_what, refusal, title) => {
    let calls = 0;
    only({
      [`GET ${base}`]: () => {
        calls += 1;
        return calls > 1 ? refusal() : json(200, folder);
      },
      [`GET ${base}/entries`]: refusal,
    });
    renderApp(`/s/${token}`);
    expect(await screen.findByText(title)).toBeDefined();
    expect(screen.queryByText("Photos")).toBeNull();
  });
});
