import { UPDATE_FROM_UI_ON_COMMAND, problemTypes, type LatestRelease, type Update, type UpdatesOverview } from "@not-unreachable/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adminSession, baseHandlers, json, problem, renderApp, requestsTo, stubApi, type MockHandler } from "../testing/index.ts";
import { updateTiming } from "./updates-settings.tsx";

const path = "/api/v1/admin/updates";
const requestId = "6f1c2a4e-8b3d-4c5e-9f60-7a8b9c0d1e2f";
const installerCommand = "curl -fsSL https://github.com/przemczan/not-unreachable/releases/latest/download/install.sh | sudo bash";
const journalCommand = "journalctl -u not-unreachable-update-apply -u not-unreachable";

const release: LatestRelease = {
  version: "1.5.0",
  publishedAt: "2026-11-20T10:00:00.000Z",
  releaseNotesUrl: "https://github.com/przemczan/not-unreachable/releases/tag/v1.5.0",
  installable: true,
  notInstallableBecause: null,
};

const checkedAt = new Date(Date.now() - 12 * 60_000).toISOString();

function overviewWith(patch: Partial<UpdatesOverview> = {}): UpdatesOverview {
  return {
    current: { version: "1.4.0" },
    check: { enabled: true, checkedAt, failedAt: null, latest: release },
    install: { enabled: true, switchCommand: UPDATE_FROM_UI_ON_COMMAND, installerCommand },
    update: null,
    ...patch,
  };
}

function updateWith(patch: Partial<Update> = {}): Update {
  return {
    requestId,
    from: "1.4.0",
    to: "1.5.0",
    phase: "downloading",
    result: null,
    reason: null,
    startedAt: "2026-11-25T14:02:11.000Z",
    finishedAt: null,
    ...patch,
  };
}

function finished(result: Update["result"], reason: Update["reason"] = null): Update {
  return updateWith({ phase: "finished", result, reason, finishedAt: "2026-11-25T14:03:40.000Z" });
}

const upToDate: UpdatesOverview = overviewWith({
  current: { version: "1.5.0" },
  check: { enabled: true, checkedAt, failedAt: null, latest: { ...release, installable: false, notInstallableBecause: "not-newer" } },
});

function handlers(overview: UpdatesOverview | (() => Response), extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    ...baseHandlers({ session: adminSession }),
    [`GET ${path}`]: typeof overview === "function" ? overview : () => json(200, overview),
    ...extra,
  };
}

async function openTab(heading: string | RegExp): Promise<HTMLElement> {
  renderApp("/admin/settings/updates");
  return screen.findByRole("heading", { level: 3, name: heading });
}

async function notesLinks(releaseNotesUrl: string): Promise<(string | null)[]> {
  stubApi(handlers(overviewWith({ check: { enabled: true, checkedAt, failedAt: null, latest: { ...release, releaseNotesUrl } } })));
  await openTab("NotUnreachable 1.5.0 is available");
  const links = screen.getAllByRole("link", { name: /Release notes/ });
  expect(links.length).toBeGreaterThan(0);
  return links.map((link) => link.getAttribute("href"));
}

function commandIn(container: HTMLElement, label: string): string | null | undefined {
  return within(container).getByRole("group", { name: label }).querySelector("code")?.textContent;
}

function type(container: HTMLElement, label: string, value: string): void {
  fireEvent.change(within(container).getByLabelText(label), { target: { value } });
}

function installWith(dialog: HTMLElement, password: string, code: string): void {
  type(dialog, "Password", password);
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Digit 1 of 6" }), { target: { value: code } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Install and restart" }));
}

async function openInstallDialog(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "Install 1.5.0" }));
  return screen.findByRole("dialog", { name: "Install NotUnreachable 1.5.0" });
}

/** A proxy's answer while the service is away. */
function unavailable(): Response {
  return problem(503, "about:blank", "Service Unavailable");
}

/**
 * The server through an update: the overview it answers, or no answer (a proxy's 503) for the
 * overview and the health check while `down`.
 */
function server(initial: UpdatesOverview) {
  let overview = initial;
  let down = false;
  return {
    handlers: {
      [`GET ${path}`]: () => (down ? unavailable() : json(200, overview)),
      "GET /api/v1/health": () => (down ? unavailable() : json(200, { status: "ok" })),
    } satisfies Record<string, MockHandler>,
    set: (next: UpdatesOverview) => {
      overview = next;
    },
    stop: () => {
      down = true;
    },
    start: (next: UpdatesOverview) => {
      overview = next;
      down = false;
    },
  };
}

describe("Admin settings → Updates", () => {
  const timing = { ...updateTiming };

  beforeEach(() => {
    Object.assign(updateTiming, { pollEveryMs: 10, requestLostMs: 150, firstCheckMs: 1, checkEveryMs: 5, giveUpMs: 300 });
  });

  afterEach(() => {
    Object.assign(updateTiming, timing);
  });

  describe("what it shows", () => {
    it("is the Updates tab, and says when checking is off", async () => {
      stubApi(handlers(overviewWith({ check: { enabled: false } })));
      await openTab("This server runs 1.4.0");

      const tabs = screen.getByRole("navigation", { name: "Settings sections" });
      expect(within(tabs).getByRole("link", { name: "Updates" }).getAttribute("aria-current")).toBe("page");
      expect(
        screen.getByText(
          "Checking for new releases is turned off on this server, so nothing is asked of GitHub. See the releases on GitHub and install over SSH.",
        ),
      ).toBeDefined();
      const all = screen.getByRole("link", { name: /All releases/ });
      expect(all.getAttribute("href")).toBe("https://github.com/przemczan/not-unreachable/releases");
      expect(all.getAttribute("target")).toBe("_blank");
      expect(all.getAttribute("rel")).toBe("noopener noreferrer");
      expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
      expect(screen.queryByText("Latest release")).toBeNull();
    });

    it("says when GitHub hasn't answered yet", async () => {
      stubApi(handlers(overviewWith({ check: { enabled: true, checkedAt: null, failedAt: null, latest: null } })));
      await openTab("This server runs 1.4.0");

      expect(screen.getByText("It hasn't heard from GitHub about new releases yet. The server checks every 6 hours.")).toBeDefined();
      expect(screen.getByText("Not known yet")).toBeDefined();
      expect(screen.getByText("Not yet")).toBeDefined();
      expect(screen.getAllByRole("button", { name: "Check now" })).toHaveLength(1);
    });

    it("says when the server is up to date", async () => {
      stubApi(handlers(upToDate));
      await openTab("You're up to date");

      expect(screen.getByText("1.5.0 is the latest release. Checked 12 minutes ago.")).toBeDefined();
      expect(screen.getAllByRole("button", { name: "Check now" })).toHaveLength(1);
      expect(screen.queryByText("Update available")).toBeNull();
      expect(screen.queryByRole("button", { name: /Install/ })).toBeNull();
    });

    it("offers to install a newer release when installing from here is on", async () => {
      stubApi(handlers(overviewWith()));
      await openTab("NotUnreachable 1.5.0 is available");

      expect(screen.getByText(/^You run 1\.4\.0\. Released on /)).toBeDefined();
      expect(screen.getByText("Update available")).toBeDefined();
      expect(screen.getByRole("button", { name: "Install 1.5.0" })).toHaveProperty("disabled", false);
      expect(screen.getByText(/Installing restarts the service, which takes about a minute\./)).toBeDefined();
      const [notes] = screen.getAllByRole("link", { name: /Release notes/ });
      expect(notes?.getAttribute("href")).toBe(release.releaseNotesUrl);
      expect(notes?.getAttribute("target")).toBe("_blank");
      expect(notes?.getAttribute("rel")).toBe("noopener noreferrer");
      expect(screen.getByText("12 minutes ago")).toBeDefined();
    });

    it("links release notes elsewhere to all the releases", async () => {
      stubApi(
        handlers(
          overviewWith({
            check: { enabled: true, checkedAt, failedAt: null, latest: { ...release, releaseNotesUrl: "https://example.com/x" } },
          }),
        ),
      );
      await openTab("NotUnreachable 1.5.0 is available");

      for (const link of screen.getAllByRole("link", { name: /Release notes/ })) {
        expect(link.getAttribute("href")).toBe("https://github.com/przemczan/not-unreachable/releases");
      }
    });

    describe("release notes", () => {
      const allReleases = "https://github.com/przemczan/not-unreachable/releases";

      it.each([`${allReleases}/tag/v1.5.0`, `${allReleases}/tag/v1.5.0-rc.1`, `${allReleases}/latest`])("keeps %s", async (url) => {
        for (const href of await notesLinks(url)) expect(href).toBe(url);
      });

      it.each([
        `${allReleases}/../../evil`,
        `${allReleases}/tag/../../../evil`,
        `${allReleases}/%2e%2e/%2e%2e/evil`,
        `${allReleases}/%2E%2E/evil`,
        "https://evil.example/przemczan/not-unreachable/releases/tag/v1",
        "https://github.com.evil.example/przemczan/not-unreachable/releases/tag/v1",
        "https://github.com:444/przemczan/not-unreachable/releases/tag/v1",
        "http://github.com/przemczan/not-unreachable/releases/tag/v1",
        "https://github.com/przemczan/not-unreachable-evil/releases/tag/v1",
        "https://github.com/przemczan/not-unreachable/releases-evil/tag/v1",
        "javascript:alert(1)",
      ])("links %s to all the releases", async (url) => {
        for (const href of await notesLinks(url)) expect(href).toBe(allReleases);
      });
    });

    it("shows the commands instead of Install when installing from here is off", async () => {
      stubApi(handlers(overviewWith({ install: { enabled: false, switchCommand: UPDATE_FROM_UI_ON_COMMAND, installerCommand } })));
      const hero = (await openTab("NotUnreachable 1.5.0 is available")).closest("section");
      if (hero === null) throw new Error("No hero");

      expect(within(hero).getByText("Install it on the server")).toBeDefined();
      expect(commandIn(hero, "Install over SSH")).toBe(installerCommand);
      expect(commandIn(hero, "Or turn installing from here on")).toBe(UPDATE_FROM_UI_ON_COMMAND);
      expect(screen.queryByRole("button", { name: "Install 1.5.0" })).toBeNull();
    });

    it("says why the latest release can't be installed from here", async () => {
      stubApi(
        handlers(
          overviewWith({
            check: {
              enabled: true,
              checkedAt,
              failedAt: null,
              latest: { ...release, installable: false, notInstallableBecause: "unsigned" },
            },
          }),
        ),
      );
      await openTab("NotUnreachable 1.5.0 is available");

      expect(screen.getByRole("button", { name: "Install 1.5.0" })).toHaveProperty("disabled", true);
      expect(
        screen.getByText(
          "This release isn't signed, so it can't be installed from here. Install it over SSH once; later releases can then be installed from here.",
        ),
      ).toBeDefined();
      expect(commandIn(document.body, "Install over SSH")).toBe(installerCommand);
    });

    it("says when the last check failed, and shows the last answer", async () => {
      const failedAt = new Date().toISOString();
      stubApi(handlers(overviewWith({ check: { enabled: true, checkedAt, failedAt, latest: release } })));
      await openTab("NotUnreachable 1.5.0 is available");

      expect(screen.getByText(/^GitHub couldn't be reached at /)).toBeDefined();
      expect(screen.getByText(/^This shows the last answer, from .+\. The server tries again in 6 hours\.$/)).toBeDefined();
      expect(screen.getByText(/^as of /)).toBeDefined();
    });

    it("shows the last update", async () => {
      stubApi(handlers(overviewWith({ current: { version: "1.5.0" }, check: upToDate.check, update: finished("succeeded") })));
      await openTab("You're up to date");

      expect(screen.getByText("Last update")).toBeDefined();
      expect(screen.getByText("Updated")).toBeDefined();
    });

    it("checks now, and says when it was asked too often", async () => {
      let checks = 0;
      const fetchMock = stubApi(
        handlers(overviewWith({ check: { enabled: true, checkedAt: null, failedAt: null, latest: null } }), {
          [`POST ${path}/check`]: () => (++checks === 1 ? json(200, overviewWith()) : problem(429, problemTypes.rateLimited, "Too many")),
        }),
      );
      await openTab("This server runs 1.4.0");

      fireEvent.click(screen.getByRole("button", { name: "Check now" }));
      expect(await screen.findByText("Checked for updates")).toBeDefined();
      expect(await screen.findByRole("heading", { level: 3, name: "NotUnreachable 1.5.0 is available" })).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: "Check now" }));
      expect(await screen.findByText("You checked a moment ago. Try again in a minute.")).toBeDefined();
      expect(requestsTo(fetchMock, `POST ${path}/check`)).toHaveLength(2);
    });
  });

  describe("results", () => {
    it("says an update was rolled back, with the reason in words and the journal", async () => {
      stubApi(handlers(overviewWith({ update: finished("rolled-back", "unhealthy") })));
      const hero = (await openTab("The update to 1.5.0 was rolled back")).closest("section");
      if (hero === null) throw new Error("No hero");

      expect(
        within(hero).getByText(
          "1.5.0 didn't keep running after it started, so the server went back to 1.4.0 with its data as before the update.",
        ),
      ).toBeDefined();
      expect(commandIn(hero, "See what happened, on the server")).toBe(journalCommand);
      expect(within(hero).getByRole("button", { name: "Try again" })).toBeDefined();
      expect(screen.getByText("Rolled back")).toBeDefined();
    });

    it("says a refused update changed nothing", async () => {
      stubApi(handlers(overviewWith({ update: finished("refused", "signature-invalid") })));
      await openTab("1.5.0 wasn't installed");

      expect(
        screen.getByText(
          "Its signature doesn't match NotUnreachable's release key, so the download may have been changed. Nothing on the server was changed.",
        ),
      ).toBeDefined();
      expect(screen.getByText("Try again later. If it happens again, report it on GitHub.")).toBeDefined();
    });

    it.each(["download-failed", "download-incomplete", "no-space", "busy", "internal", "systemd-failed", "request-invalid"] as const)(
      "offers to try again a refused update that may pass next time (%s)",
      async (reason) => {
        stubApi(handlers(overviewWith({ update: finished("refused", reason) })));
        const hero = (await openTab("1.5.0 wasn't installed")).closest("section");
        if (hero === null) throw new Error("No hero");

        expect(within(hero).getByRole("button", { name: "Try again" })).toBeDefined();
      },
    );

    it("offers to try again a refused update with no reason", async () => {
      stubApi(handlers(overviewWith({ update: finished("refused", null) })));
      await openTab("1.5.0 wasn't installed");

      expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
    });

    it.each([
      "signature-invalid",
      "not-newer",
      "unsigned",
      "checksum-mismatch",
      "version-mismatch",
      "switch-off",
      "needs-installer",
    ] as const)("doesn't offer to try again a refused update that trying again won't change (%s)", async (reason) => {
      stubApi(handlers(overviewWith({ update: finished("refused", reason) })));
      await openTab("1.5.0 wasn't installed");

      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(screen.queryByRole("button", { name: /Install/ })).toBeNull();
    });

    it("doesn't offer to try again when installing from here is off", async () => {
      stubApi(
        handlers(
          overviewWith({
            install: { enabled: false, switchCommand: UPDATE_FROM_UI_ON_COMMAND, installerCommand },
            update: finished("refused", "busy"),
          }),
        ),
      );
      await openTab("1.5.0 wasn't installed");

      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });

    it("shows the installer for a release that needs it", async () => {
      stubApi(handlers(overviewWith({ update: finished("refused", "needs-installer") })));
      await openTab("1.5.0 wasn't installed");

      expect(commandIn(document.body, "Install over SSH")).toBe(installerCommand);
    });

    it("says when the rollback failed too", async () => {
      stubApi(handlers(overviewWith({ update: finished("rollback-failed", "start-failed") })));
      await openTab("The update to 1.5.0 failed and couldn't be rolled back");

      expect(commandIn(document.body, "See what happened, on the server")).toBe(journalCommand);
    });

    it("says how to recover an update that stopped half-way", async () => {
      stubApi(handlers(overviewWith({ update: finished("interrupted", "interrupted") })));
      await openTab("The update to 1.5.0 stopped half-way");

      expect(screen.getByText(/^The server stopped during the update, for example in a power cut\./)).toBeDefined();
      expect(screen.getByText("sudo not-unreachable update-recover")).toBeDefined();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });
  });

  describe("installing", () => {
    it("asks for the password and a code, and says when either is wrong", async () => {
      let answer = 0;
      const fetchMock = stubApi(
        handlers(overviewWith(), {
          [`POST ${path}/install`]: () =>
            ++answer === 1 ? problem(401, problemTypes.signInFailed) : problem(401, problemTypes.secondFactorFailed),
        }),
      );
      await openTab("NotUnreachable 1.5.0 is available");
      const dialog = await openInstallDialog();

      expect(document.activeElement).toBe(within(dialog).getByLabelText("Password"));
      fireEvent.click(within(dialog).getByRole("button", { name: "Install and restart" }));
      expect(await within(dialog).findByText("Enter your password.")).toBeDefined();

      installWith(dialog, "wrong", "123456");
      expect(await within(dialog).findByText("The password is not right.")).toBeDefined();
      installWith(dialog, "right", "000000");
      expect(await within(dialog).findByText("The code is not right. Check the code in your app and try again.")).toBeDefined();
      expect(requestsTo(fetchMock, `POST ${path}/install`).map((request) => request.body)).toEqual([
        { version: "1.5.0", reauthentication: { password: "wrong", secondFactor: { code: "123456" } } },
        { version: "1.5.0", reauthentication: { password: "right", secondFactor: { code: "000000" } } },
      ]);
    });

    it("says when a newer release came out meanwhile, and reads the overview again", async () => {
      const fetchMock = stubApi(
        handlers(overviewWith(), { [`POST ${path}/install`]: () => problem(409, problemTypes.updateNotAvailable, "Not available") }),
      );
      await openTab("NotUnreachable 1.5.0 is available");
      const dialog = await openInstallDialog();
      const read = requestsTo(fetchMock, `GET ${path}`).length;
      installWith(dialog, "right", "123456");

      expect(await within(dialog).findByText("A newer release came out meanwhile. Check it, then install again.")).toBeDefined();
      await waitFor(() => expect(requestsTo(fetchMock, `GET ${path}`).length).toBeGreaterThan(read));
    });

    it("says when another update is running", async () => {
      stubApi(handlers(overviewWith(), { [`POST ${path}/install`]: () => problem(409, problemTypes.updateInProgress, "In progress") }));
      await openTab("NotUnreachable 1.5.0 is available");
      const dialog = await openInstallDialog();
      installWith(dialog, "right", "123456");

      expect(await within(dialog).findByText("Another update is running. Wait for it to finish.")).toBeDefined();
    });

    it("shows the commands once installing from here was turned off", async () => {
      stubApi(handlers(overviewWith()));
      await openTab("NotUnreachable 1.5.0 is available");
      const dialog = await openInstallDialog();
      installWith(dialog, "right", "123456");

      expect(await within(dialog).findByText("Install it on the server")).toBeDefined();
      expect(commandIn(dialog, "Or turn installing from here on")).toBe(UPDATE_FROM_UI_ON_COMMAND);
    });

    it("follows each step, waits for the service, then says it updated", async () => {
      const host = server(overviewWith());
      const fetchMock = stubApi(
        handlers(overviewWith(), {
          ...host.handlers,
          [`POST ${path}/install`]: () => {
            host.set(overviewWith({ update: updateWith({ phase: "downloading" }) }));
            return json(202, { requestId });
          },
        }),
      );
      await openTab("NotUnreachable 1.5.0 is available");
      const dialog = await openInstallDialog();
      installWith(dialog, "right", "123456");

      await within(dialog).findByRole("heading", { name: "Installing 1.5.0" });
      const live = () => within(dialog).getByRole("status").textContent;
      await waitFor(() => expect(live()).toBe("Downloading…"));

      host.set(overviewWith({ update: updateWith({ phase: "verifying" }) }));
      await waitFor(() => expect(live()).toBe("Checking the signature…"));
      host.set(overviewWith({ update: updateWith({ phase: "installing" }) }));
      await waitFor(() => expect(live()).toBe("Installing 1.5.0…"));
      host.set(overviewWith({ update: updateWith({ phase: "restarting" }) }));
      await waitFor(() => expect(live()).toBe("Restarting the service…"));

      host.stop();
      await waitFor(() => expect(requestsTo(fetchMock, "GET /api/v1/health").length).toBeGreaterThan(0));
      expect(live()).toBe("Restarting the service…");
      host.start(overviewWith({ current: { version: "1.5.0" }, check: upToDate.check, update: finished("succeeded") }));

      expect(await screen.findByText("Updated to 1.5.0")).toBeDefined();
      const title = await screen.findByRole("heading", { level: 3, name: "You're up to date" });
      await waitFor(() => expect(document.activeElement).toBe(title));
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("shows why an update was rolled back once the old release is back", async () => {
      const host = server(overviewWith());
      stubApi(
        handlers(overviewWith(), {
          ...host.handlers,
          [`POST ${path}/install`]: () => {
            host.set(overviewWith({ update: updateWith({ phase: "restarting" }) }));
            return json(202, { requestId });
          },
        }),
      );
      await openTab("NotUnreachable 1.5.0 is available");
      const dialog = await openInstallDialog();
      installWith(dialog, "right", "123456");
      await within(dialog).findByText("Restarting the service…", { selector: "output" });

      host.stop();
      await new Promise((resolve) => setTimeout(resolve, 30));
      host.start(overviewWith({ update: updateWith({ phase: "rolling-back" }) }));
      await within(dialog).findByText("Going back to 1.4.0…", { selector: "output" });
      host.set(overviewWith({ update: finished("rolled-back", "start-failed") }));

      const title = await screen.findByRole("heading", { level: 3, name: "The update to 1.5.0 was rolled back" });
      expect(
        screen.getByText("1.5.0 didn't start within 5 minutes, so the server went back to 1.4.0 with its data as before the update."),
      ).toBeDefined();
      await waitFor(() => expect(document.activeElement).toBe(title));
      expect(screen.queryByText("Updated to 1.5.0")).toBeNull();
    });

    it("moves the focus to Close when the dialog switches to the progress", async () => {
      const host = server(overviewWith());
      stubApi(
        handlers(overviewWith(), {
          ...host.handlers,
          [`POST ${path}/install`]: () => {
            host.set(overviewWith({ update: updateWith({ phase: "downloading" }) }));
            return json(202, { requestId });
          },
        }),
      );
      await openTab("NotUnreachable 1.5.0 is available");
      const dialog = await openInstallDialog();
      installWith(dialog, "right", "123456");

      await within(dialog).findByRole("heading", { name: "Installing 1.5.0" });
      await waitFor(() => {
        expect(document.activeElement?.tagName).toBe("BUTTON");
        expect(document.activeElement?.textContent).toBe("Close");
        expect(dialog.contains(document.activeElement)).toBe(true);
      });
    });

    it("says the request didn't reach the server when no update appears after its answer was lost", async () => {
      const fetchMock = stubApi(
        handlers(overviewWith(), { [`POST ${path}/install`]: () => Promise.reject(new TypeError("Failed to fetch")) }),
      );
      await openTab("NotUnreachable 1.5.0 is available");
      const dialog = await openInstallDialog();
      installWith(dialog, "right", "123456");

      await within(dialog).findByRole("heading", { name: "Installing 1.5.0" });
      const alert = await screen.findByRole("alert");
      expect(within(alert).getByText("The install request didn't reach the server")).toBeDefined();
      expect(within(alert).getByText("Nothing was changed. Try again.")).toBeDefined();
      expect(screen.queryByRole("dialog")).toBeNull();
      const title = screen.getByRole("heading", { level: 3, name: "NotUnreachable 1.5.0 is available" });
      await waitFor(() => expect(document.activeElement).toBe(title));
      expect(screen.getByRole("button", { name: "Install 1.5.0" })).toHaveProperty("disabled", false);
      expect(requestsTo(fetchMock, `POST ${path}/install`)).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: "Install 1.5.0" }));
      await screen.findByRole("dialog", { name: "Install NotUnreachable 1.5.0" });
      expect(screen.queryByText("The install request didn't reach the server")).toBeNull();
    });

    it("keeps following an update that appears after its answer was lost", async () => {
      const host = server(overviewWith());
      stubApi(
        handlers(overviewWith(), {
          ...host.handlers,
          [`POST ${path}/install`]: () => {
            setTimeout(() => host.set(overviewWith({ update: updateWith({ phase: "installing" }) })), updateTiming.requestLostMs / 3);
            return Promise.reject(new TypeError("Failed to fetch"));
          },
        }),
      );
      await openTab("NotUnreachable 1.5.0 is available");
      const dialog = await openInstallDialog();
      installWith(dialog, "right", "123456");

      await within(dialog).findByText("Installing 1.5.0…", { selector: "output" });
      await new Promise((resolve) => setTimeout(resolve, updateTiming.requestLostMs * 2));
      expect(screen.queryByText("The install request didn't reach the server")).toBeNull();
      expect(screen.getByRole("dialog", { name: "Installing 1.5.0" })).toBeDefined();
    });

    it("shows the steps of a rollback as tried and gone wrong, not as installed", async () => {
      stubApi(handlers(overviewWith({ update: updateWith({ phase: "rolling-back" }) })));
      await openTab("Installing 1.5.0");

      expect(screen.getByText("Tried 1.5.0")).toBeDefined();
      expect(screen.getByText("1.5.0 didn't work properly")).toBeDefined();
      expect(screen.getByText("Going back to 1.4.0…", { selector: "div" })).toBeDefined();
      expect(screen.queryByText("Installed")).toBeNull();
      expect(screen.queryByText("1.5.0 didn't start properly")).toBeNull();
    });

    it("shows the steps of an install as installed while it goes on", async () => {
      stubApi(handlers(overviewWith({ update: updateWith({ phase: "restarting" }) })));
      await openTab("Installing 1.5.0");

      expect(screen.getByText("Installed")).toBeDefined();
      expect(screen.queryByText("Tried 1.5.0")).toBeNull();
    });

    it("follows an update that was running when the tab opened, and says when the service doesn't come back", async () => {
      const host = server(overviewWith({ update: updateWith({ phase: "installing" }) }));
      stubApi(handlers(overviewWith(), host.handlers));
      await openTab("Installing 1.5.0");
      expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();

      host.stop();
      expect((await screen.findAllByText("The service didn't come back")).length).toBeGreaterThan(0);
      expect(screen.getByText(journalCommand)).toBeDefined();

      host.start(overviewWith({ update: finished("interrupted", "interrupted") }));
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByRole("heading", { level: 3, name: "The update to 1.5.0 stopped half-way" })).toBeDefined();
    });
  });
});
