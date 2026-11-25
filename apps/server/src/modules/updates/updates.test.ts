import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  problemTypes,
  routes,
  updatesOverviewSchema,
  type UpdateResult,
  type UpdateStatusFile,
  type UpdatesOverview,
} from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTestApp,
  createTestServices,
  expectProblem,
  fakeGitHubReleases,
  fakeUpdateHelper,
  githubRelease,
  goodPassword,
  makeTempDir,
  signedRelease,
  silentLogger,
  startFakeSmtp,
  tableRows,
  testResourceRoots,
  type FakeGitHubReleases,
  type FakeSmtp,
  type FakeUpdateHelper,
  type SignedRelease,
  type TestApp,
} from "../../test-support/index.ts";
import { callRoute } from "../../test-support/sessions.ts";
import type { AccountRecord } from "../accounts/index.ts";
import { MINUTE_MS, type JobDefinition } from "../platform/index.ts";
import { updateRequests } from "./schema.ts";
import {
  CHECK_INTERVAL_MS,
  INSTALL_LIMIT,
  INSTALLER_COMMAND,
  scheduleUpdateChecks,
  UPDATE_CHECK_JOB,
  UPDATE_REQUEST_FILE,
  type UpdatesOptions,
  type UpdatesPaths,
} from "./index.ts";

const RUNNING = "1.4.0";
const LATEST = "1.5.0";

/** The status file the update helper would write for `requestId`. */
function statusFile(
  requestId: string,
  phase: UpdateStatusFile["phase"],
  result: UpdateResult | null = null,
  reason: UpdateStatusFile["reason"] = null,
  signingKey: string | null = null,
): UpdateStatusFile {
  return {
    schema: 1,
    requestId,
    from: RUNNING,
    to: LATEST,
    phase,
    result,
    reason,
    signingKey,
    startedAt: "2026-11-24T10:16:00.000Z",
    updatedAt: "2026-11-24T10:17:00.000Z",
    finishedAt: result === null ? null : "2026-11-24T10:17:00.000Z",
  };
}

interface Setup {
  readonly temp: ReturnType<typeof makeTempDir>;
  readonly paths: UpdatesPaths;
  readonly release: SignedRelease;
  readonly github: FakeGitHubReleases;
  readonly helper: FakeUpdateHelper;
  readonly options: Partial<UpdatesOptions>;
}

function setUp(): Setup {
  const temp = makeTempDir();
  const paths: UpdatesPaths = {
    spoolDir: join(temp.dir, "data", "updates"),
    requestsDir: join(temp.dir, "run", "update-requests"),
    statusFile: join(temp.dir, "state", "status.json"),
    trustedKeysDir: join(temp.dir, "release-signing-keys"),
  };
  mkdirSync(join(temp.dir, "state"));
  const release = signedRelease(LATEST, paths.trustedKeysDir);
  const github = fakeGitHubReleases(release);
  const helper = fakeUpdateHelper(paths);
  return {
    temp,
    paths,
    release,
    github,
    helper,
    options: { fetch: github.fetch, helper, paths, runningVersion: RUNNING, arch: "x64", random: () => 0.5 },
  };
}

const overviewOf = async (test: TestApp, cookie: string): Promise<UpdatesOverview> => {
  const response = await callRoute(test, routes.getUpdates, { cookie });
  expect(response.statusCode).toBe(200);
  return updatesOverviewSchema.parse(response.json());
};

describe("Settings → Updates, switched off", () => {
  let setup: Setup;
  let test: TestApp;
  let cookie: string;

  beforeEach(async () => {
    setup = setUp();
    test = await buildTestApp({ config: { updateCheck: false, updateFromUi: false }, updates: setup.options });
    cookie = await test.signIn((await test.createAdmin()).username);
  });
  afterEach(async () => {
    await test.close();
    setup.temp.cleanup();
  });

  it("with UPDATE_CHECK off asks GitHub nothing at all, and Check now and Install don't exist", async () => {
    expect(await overviewOf(test, cookie)).toEqual({
      current: { version: RUNNING },
      check: { enabled: false },
      install: { enabled: false, switchCommand: "sudo not-unreachable update-from-ui on", installerCommand: INSTALLER_COMMAND },
      update: null,
    });
    expect(INSTALLER_COMMAND).toBe(
      "curl -fsSL https://github.com/przemczan/not-unreachable/releases/latest/download/install.sh | sudo bash",
    );
    expectProblem(await callRoute(test, routes.checkForUpdates, { cookie }), 404, problemTypes.notFound);
    const payload = { version: LATEST, reauthentication: { password: goodPassword, secondFactor: { code: "123456" } } };
    expectProblem(await callRoute(test, routes.installUpdate, { cookie, payload }), 404, problemTypes.notFound);
    expectProblem(await callRoute(test, routes.installUpdate, { payload }), 404, problemTypes.notFound);

    // Nor the schedule: no job, and a due check does nothing.
    const jobs: JobDefinition[] = [];
    scheduleUpdateChecks({ register: (job) => jobs.push(job), start: () => undefined, stop: () => undefined }, test.services.updates);
    expect(jobs).toEqual([]);
    test.clock.advance(7 * 24 * 60 * MINUTE_MS);
    await test.services.updates.checkIfDue();
    expect(setup.github.requests).toEqual([]);
    expect(test.audited("update.requested")).toEqual([]);
  });
});

describe("the release check", () => {
  let setup: Setup;
  let test: TestApp;
  let admin: AccountRecord;
  let cookie: string;

  beforeEach(async () => {
    setup = setUp();
    test = await buildTestApp({ config: { updateCheck: true }, updates: setup.options });
    admin = await test.createAdmin();
    cookie = await test.signIn(admin.username);
  });
  afterEach(async () => {
    await test.close();
    setup.temp.cleanup();
  });

  const checkNow = () => callRoute(test, routes.checkForUpdates, { cookie });

  it("shows nothing before GitHub first answered, then the latest release, installable, without Install while the switch is off", async () => {
    expect((await overviewOf(test, cookie)).check).toEqual({ enabled: true, checkedAt: null, failedAt: null, latest: null });
    const response = await checkNow();
    expect(response.statusCode).toBe(200);
    const overview = updatesOverviewSchema.parse(response.json());
    expect(overview.check).toEqual({
      enabled: true,
      checkedAt: test.clock.now().toISOString(),
      failedAt: null,
      latest: {
        version: LATEST,
        publishedAt: "2026-11-25T12:00:00.000Z",
        releaseNotesUrl: "https://github.com/przemczan/not-unreachable/releases/tag/v1.5.0",
        installable: true,
        notInstallableBecause: null,
      },
    });
    expect(overview.install.enabled).toBe(false);
    expect(setup.github.requests).toEqual([
      {
        url: "https://api.github.com/repos/przemczan/not-unreachable/releases/latest",
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "not-unreachable" },
      },
    ]);
    // The install route doesn't exist while UPDATE_FROM_UI is off, even with an installable release.
    const payload = { version: LATEST, reauthentication: { password: goodPassword, secondFactor: { code: "123456" } } };
    expectProblem(await callRoute(test, routes.installUpdate, { cookie, payload }), 404, problemTypes.notFound);
  });

  it.each([
    ["not-newer", githubRelease(RUNNING)],
    ["not-newer", githubRelease("1.3.9")],
    ["no-tarball", githubRelease(LATEST, ["not-unreachable-1.5.0-linux-arm64.tar.gz", "SHA256SUMS", "SHA256SUMS.sig"])],
    ["unsigned", githubRelease(LATEST, ["not-unreachable-1.5.0-linux-x64.tar.gz", "SHA256SUMS"])],
  ] as const)("says the latest release isn't installable: %s", async (reason, latest) => {
    setup.github.latest = latest;
    const overview = updatesOverviewSchema.parse((await checkNow()).json());
    expect(overview.check).toMatchObject({ latest: { installable: false, notInstallableBecause: reason } });
  });

  it("keeps the last good answer when a check fails, and shows when it failed", async () => {
    await checkNow();
    const answeredAt = test.clock.now().toISOString();
    test.clock.advance(2 * MINUTE_MS);
    setup.github.latest = () => new Response("oops", { status: 502 });
    const failed = updatesOverviewSchema.parse((await checkNow()).json());
    expect(failed.check).toMatchObject({ checkedAt: answeredAt, failedAt: test.clock.now().toISOString(), latest: { version: LATEST } });

    test.clock.advance(2 * MINUTE_MS);
    setup.github.latest = () => Response.json({ tag_name: "v9.9.9", html_url: "https://evil.example/" });
    expect(updatesOverviewSchema.parse((await checkNow()).json()).check).toMatchObject({
      checkedAt: answeredAt,
      latest: { version: LATEST },
    });

    test.clock.advance(2 * MINUTE_MS);
    setup.github.latest = githubRelease("1.6.0");
    expect(updatesOverviewSchema.parse((await checkNow()).json()).check).toMatchObject({
      checkedAt: test.clock.now().toISOString(),
      failedAt: null,
      latest: { version: "1.6.0" },
    });
  });

  it("answers Check now once a minute and 10 times an hour for the instance, then 429", async () => {
    expect((await checkNow()).statusCode).toBe(200);
    const limited = await checkNow();
    expectProblem(limited, 429, problemTypes.rateLimited);
    expect(Number(limited.headers["retry-after"])).toBe(60);
    // Another admin session is the same instance.
    expectProblem(await callRoute(test, routes.checkForUpdates, { cookie: test.startSession(admin) }), 429, problemTypes.rateLimited);
    for (let i = 1; i < 10; i++) {
      test.clock.advance(MINUTE_MS);
      expect((await checkNow()).statusCode).toBe(200);
    }
    test.clock.advance(MINUTE_MS);
    const hourly = await checkNow();
    expectProblem(hourly, 429, problemTypes.rateLimited);
    expect(Number(hourly.headers["retry-after"])).toBeGreaterThan(60);
    expect(setup.github.requests).toHaveLength(10);
  });

  it("keeps the answer in the database, so a restart doesn't ask again until 6 hours (± 30 minutes) later", async () => {
    await checkNow();
    const restart = () =>
      createTestServices(test.database, test.clock, silentLogger, undefined, testResourceRoots, {
        updates: { ...setup.options, check: true },
      }).updates;
    let updates = restart();
    test.clock.advance(5 * MINUTE_MS);
    await updates.checkIfDue();
    expect(setup.github.requests).toHaveLength(1);
    test.clock.advance(CHECK_INTERVAL_MS - 6 * MINUTE_MS);
    await updates.checkIfDue();
    expect(setup.github.requests).toHaveLength(1);
    test.clock.advance(2 * MINUTE_MS);
    await updates.checkIfDue();
    expect(setup.github.requests).toHaveLength(2);

    // Started with an answer older than 6 hours: 1 to 5 minutes later (3 with this jitter).
    test.clock.advance(CHECK_INTERVAL_MS + MINUTE_MS);
    updates = restart();
    await updates.checkIfDue();
    test.clock.advance(2 * MINUTE_MS);
    await updates.checkIfDue();
    expect(setup.github.requests).toHaveLength(2);
    test.clock.advance(MINUTE_MS);
    await updates.checkIfDue();
    expect(setup.github.requests).toHaveLength(3);
  });

  it("schedules the check as a job every minute, which asks only when it is due", () => {
    const jobs: JobDefinition[] = [];
    scheduleUpdateChecks({ register: (job) => jobs.push(job), start: () => undefined, stop: () => undefined }, test.services.updates);
    expect(jobs).toMatchObject([{ name: UPDATE_CHECK_JOB, intervalMs: MINUTE_MS, firstRunAfterMs: MINUTE_MS }]);
  });
});

describe("installing an update from Settings", () => {
  let setup: Setup;
  let test: TestApp;
  let admin: AccountRecord;
  let cookie: string;

  beforeEach(async () => {
    setup = setUp();
    test = await buildTestApp({ config: { updateCheck: true, updateFromUi: true }, updates: setup.options });
    admin = await test.createAdmin();
    cookie = await test.signIn(admin.username);
    const checked = await callRoute(test, routes.checkForUpdates, { cookie });
    if (checked.statusCode !== 200) throw new Error(`The release check failed with ${checked.statusCode}`);
    setup.github.requests.length = 0;
  });
  afterEach(async () => {
    await test.services.updates.settled();
    await test.close();
    setup.temp.cleanup();
  });

  const bothFactors = () => ({ password: goodPassword, secondFactor: { code: test.totpCode(admin.id) } });
  const install = (version: string = LATEST, reauthentication: object = bothFactors(), as = cookie) =>
    callRoute(test, routes.installUpdate, { cookie: as, payload: { version, reauthentication } });
  const accepted = async (): Promise<string> => {
    const response = await install();
    expect(response.statusCode).toBe(202);
    await test.services.updates.settled();
    return response.json<{ requestId: string }>().requestId;
  };
  const writeStatus = (status: UpdateStatusFile | string): void =>
    writeFileSync(setup.paths.statusFile, typeof status === "string" ? status : JSON.stringify(status));
  const restart = () =>
    createTestServices(test.database, test.clock, silentLogger, undefined, testResourceRoots, {
      updates: { ...setup.options, check: true, fromUi: true },
    }).updates;
  const withSmtp = async (work: (smtp: FakeSmtp) => Promise<void>): Promise<void> => {
    const smtp = await startFakeSmtp();
    try {
      const mail = { host: "127.0.0.1", port: smtp.port, tlsMode: "none", username: null, fromAddress: "noreply@example.com" };
      expect((await callRoute(test, routes.updateMailSettings, { cookie, payload: mail })).statusCode).toBe(200);
      await work(smtp);
    } finally {
      await smtp.close();
    }
  };

  it("downloads the release, writes the request 0600, starts the helper, answers 202 and records it", async () => {
    setup.helper.status = (requestId) => statusFile(requestId, "verified", null, null, setup.release.keyId);
    const response = await install();
    expect(response.statusCode).toBe(202);
    const { requestId } = response.json<{ requestId: string }>();
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await test.services.updates.settled();

    expect(setup.github.requests.map((request) => request.url)).toEqual([
      "https://github.com/przemczan/not-unreachable/releases/download/v1.5.0/SHA256SUMS",
      "https://release-assets.githubusercontent.com/SHA256SUMS?sig=x",
      "https://github.com/przemczan/not-unreachable/releases/download/v1.5.0/SHA256SUMS.sig",
      "https://release-assets.githubusercontent.com/SHA256SUMS.sig?sig=x",
      "https://github.com/przemczan/not-unreachable/releases/download/v1.5.0/not-unreachable-1.5.0-linux-x64.tar.gz",
      "https://release-assets.githubusercontent.com/not-unreachable-1.5.0-linux-x64.tar.gz?sig=x",
    ]);
    expect(setup.helper.runs).toEqual([
      {
        request: JSON.stringify({ requestId, version: LATEST }),
        fileMode: 0o600,
        dirMode: 0o700,
        spool: new Map([
          ["SHA256SUMS", setup.release.files.get("SHA256SUMS")],
          ["SHA256SUMS.sig", setup.release.files.get("SHA256SUMS.sig")],
        ]),
      },
    ]);
    // The request is deleted and the spool emptied once the helper has its own copies.
    expect(existsSync(join(setup.paths.requestsDir, UPDATE_REQUEST_FILE))).toBe(false);
    expect(readdirSync(setup.paths.spoolDir)).toEqual([]);

    expect(test.audited("update.requested")).toMatchObject([
      { actorUsername: "admin", outcome: "succeeded", details: { requestId, from: RUNNING, to: LATEST, outcome: "accepted" } },
    ]);
    expect(test.audited("update.finished")).toEqual([]);
    expect((await overviewOf(test, cookie)).update).toEqual({
      requestId,
      from: RUNNING,
      to: LATEST,
      phase: "verified",
      result: null,
      reason: null,
      startedAt: expect.any(String),
      finishedAt: null,
    });
    expect(JSON.stringify(test.logs())).not.toContain(goodPassword);
  });

  it("refuses a second request while the status file says an update is in progress", async () => {
    writeStatus({ ...statusFile("01900000-0000-7000-8000-000000000001", "installing"), to: "1.5.0" });
    expectProblem(await install(), 409, problemTypes.updateInProgress);
    expect(test.audited("update.requested")).toMatchObject([{ outcome: "denied", details: { outcome: "refused", to: LATEST } }]);
    expect(setup.helper.runs).toEqual([]);
    expect(setup.github.requests).toEqual([]);
  });

  it.each([
    ["an older release", "1.3.0"],
    ["the running release", RUNNING],
    ["a newer release that isn't the latest", "1.6.0"],
  ])("refuses %s with 409 update-not-available", async (_case, version) => {
    const problem = expectProblem(await install(version), 409, problemTypes.updateNotAvailable);
    expect(JSON.stringify(problem)).not.toContain(setup.temp.dir);
    expect(test.audited("update.requested")).toMatchObject([
      { outcome: "denied", details: { outcome: "refused", from: RUNNING, to: version } },
    ]);
    expect(setup.github.requests).toEqual([]);
  });

  it("refuses the latest release with 409 when it isn't installable", async () => {
    setup.github.latest = githubRelease(LATEST, ["SHA256SUMS"]);
    test.clock.advance(MINUTE_MS);
    await callRoute(test, routes.checkForUpdates, { cookie });
    expectProblem(await install(), 409, problemTypes.updateNotAvailable);
  });

  it("answers a wrong password 401 sign-in-failed, and records it, before anything is downloaded", async () => {
    expectProblem(
      await install(LATEST, { password: "not the password", secondFactor: { code: test.totpCode(admin.id) } }),
      401,
      problemTypes.signInFailed,
    );
    expect(test.audited("update.requested")).toMatchObject([{ outcome: "denied", details: { outcome: "denied" } }]);
    expect(test.audited("sign-in.failed")).toHaveLength(1);
    expect(test.audited("second-factor.failed")).toEqual([]);
    expect(setup.github.requests).toEqual([]);
    expect(tableRows(test, "update_requests")).toEqual([]);
  });

  it("answers the right password with a wrong code 401 second-factor-failed", async () => {
    const code = test.totpCode(admin.id);
    const wrong = `${code.slice(0, 5)}${(Number(code.at(5)) + 5) % 10}`;
    expectProblem(await install(LATEST, { password: goodPassword, secondFactor: { code: wrong } }), 401, problemTypes.secondFactorFailed);
    expect(test.audited("update.requested")).toMatchObject([{ details: { outcome: "denied" } }]);
    expect(test.audited("second-factor.failed")).toMatchObject([{ details: { method: "totp", during: "confirm" } }]);
    expect(setup.github.requests).toEqual([]);
  });

  it("refuses a request without both factors with 400, recording nothing", async () => {
    for (const reauthentication of [{ password: goodPassword }, { password: goodPassword, secondFactor: {} }]) {
      expectProblem(await install(LATEST, reauthentication), 400, problemTypes.validationFailed);
    }
    expectProblem(
      await callRoute(test, routes.installUpdate, { cookie, payload: { version: "latest", reauthentication: bothFactors() } }),
      400,
      problemTypes.validationFailed,
    );
    expect(test.audited("update.requested")).toEqual([]);
  });

  it(`answers 429 past ${INSTALL_LIMIT.max} requests in 15 minutes per admin, and records it`, async () => {
    for (let i = 0; i < INSTALL_LIMIT.max; i++) expectProblem(await install("1.3.0"), 409, problemTypes.updateNotAvailable);
    const limited = await install();
    expectProblem(limited, 429, problemTypes.rateLimited);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(test.audited("update.requested")[0]).toMatchObject({ outcome: "denied", details: { outcome: "denied", to: LATEST } });
    expect(setup.github.requests).toEqual([]);

    test.clock.advance(INSTALL_LIMIT.windowMs);
    cookie = await test.signIn(admin.username);
    expect((await install()).statusCode).toBe(202);
  });

  it("is for the admin only", async () => {
    const userCookie = test.startSession(test.createUser());
    for (const route of [routes.getUpdates, routes.checkForUpdates]) {
      expectProblem(await callRoute(test, route, { cookie: userCookie }), 403, problemTypes.forbidden);
      expectProblem(await callRoute(test, route), 401, problemTypes.signInRequired);
    }
    expectProblem(await install(LATEST, bothFactors(), userCookie), 403, problemTypes.forbidden);
    expectProblem(await install(LATEST, bothFactors(), ""), 401, problemTypes.signInRequired);
    expect(test.audited("update.requested")).toEqual([]);
    expect(setup.github.requests).toEqual([]);
  });

  it.each([
    [
      "signed by a key the running release doesn't pin",
      "unsigned",
      (target: Setup) => {
        target.github.files = signedRelease(LATEST, join(target.temp.dir, "other-keys")).files;
      },
    ],
    [
      "with SHA256SUMS changed by one byte",
      "signature-invalid",
      (target: Setup) => {
        const checksums = Buffer.from(target.release.files.get("SHA256SUMS") ?? "");
        checksums[0] = checksums[0] === 0x61 ? 0x62 : 0x61;
        target.github.files.set("SHA256SUMS", checksums);
      },
    ],
    [
      "with a malformed signature file",
      "signature-invalid",
      (target: Setup) => {
        target.github.files.set("SHA256SUMS.sig", Buffer.from("not a signature\n"));
      },
    ],
    [
      "with the tarball changed by one byte",
      "checksum-mismatch",
      (target: Setup) => {
        const name = "not-unreachable-1.5.0-linux-x64.tar.gz";
        const tarball = Buffer.from(target.release.files.get(name) ?? "");
        tarball[0] = (tarball[0] ?? 0) ^ 1;
        target.github.files.set(name, tarball);
      },
    ],
    [
      "when the running release's keys can't be read",
      "internal",
      (target: Setup) => {
        rmSync(target.paths.trustedKeysDir, { recursive: true });
      },
    ],
    [
      "without a signature on GitHub",
      "download-failed",
      (target: Setup) => {
        target.github.files.delete("SHA256SUMS.sig");
      },
    ],
    [
      "with a SHA256SUMS over its 16 KiB cap",
      "download-incomplete",
      (target: Setup) => {
        target.github.files.set("SHA256SUMS", Buffer.alloc(16 * 1024 + 1, 0x61));
      },
    ],
  ] as const)("refuses a release %s before the helper runs (%s), and records update.finished", async (_case, reason, spoil) => {
    spoil(setup);
    const requestId = await accepted();
    expect(setup.helper.runs).toEqual([]);
    expect(readdirSync(setup.paths.spoolDir)).toEqual([]);
    expect((await overviewOf(test, cookie)).update).toMatchObject({ requestId, phase: "finished", result: "refused", reason });
    expect(test.audited("update.finished")).toMatchObject([
      {
        actorUsername: "admin",
        outcome: "failed",
        details: { requestId, from: RUNNING, to: LATEST, result: "refused", reason, signingKey: null },
      },
    ]);
    expect(test.logs()).toContainEqual(expect.objectContaining({ reason, to: LATEST }));
  });

  it("records a refusal by the helper's exit code alone when it wrote no status (busy)", async () => {
    setup.helper.outcome = { ok: false, reason: "busy" };
    const requestId = await accepted();
    expect(setup.helper.runs).toHaveLength(1);
    expect(existsSync(join(setup.paths.requestsDir, UPDATE_REQUEST_FILE))).toBe(false);
    expect((await overviewOf(test, cookie)).update).toMatchObject({ requestId, phase: "finished", result: "refused", reason: "busy" });
    expect(test.audited("update.finished")).toMatchObject([{ details: { result: "refused", reason: "busy", signingKey: null } }]);
  });

  it("records a refusal from the helper's status file, with the key that verified the release", async () => {
    setup.helper.outcome = { ok: false, reason: "version-mismatch" };
    setup.helper.status = (requestId) => statusFile(requestId, "finished", "refused", "version-mismatch", setup.release.keyId);
    const requestId = await accepted();
    expect(test.audited("update.finished")).toMatchObject([
      { details: { requestId, result: "refused", reason: "version-mismatch", signingKey: setup.release.keyId } },
    ]);
  });

  it("records update.finished once, by the new release after a success, and emails the admin a security notice", async () => {
    await withSmtp(async (smtp) => {
      setup.helper.status = (id) => statusFile(id, "verified", null, null, setup.release.keyId);
      const requestId = await accepted();
      expect(test.audited("update.finished")).toEqual([]);

      writeStatus(statusFile(requestId, "finished", "succeeded", null, setup.release.keyId));
      const newRelease = restart();
      await newRelease.recordFinished();
      await newRelease.recordFinished();
      await overviewOf(test, cookie);
      expect(test.audited("update.finished")).toMatchObject([
        {
          actorUsername: "admin",
          actorAccountId: admin.id,
          outcome: "succeeded",
          details: { requestId, from: RUNNING, to: LATEST, result: "succeeded", reason: null, signingKey: setup.release.keyId },
        },
      ]);
      expect((await overviewOf(test, cookie)).update).toMatchObject({ requestId, phase: "finished", result: "succeeded", reason: null });
      await vi.waitFor(() => expect(smtp.received).toHaveLength(1));
      expect(smtp.received[0]).toMatchObject({ to: ["admin@example.com"] });
      expect(smtp.received[0]?.raw).toContain("was updated to 1.5.0 from Settings");
    });
  });

  it.each([
    ["rolled-back", "was rolled back"],
    ["rollback-failed", "so did the rollback"],
  ] as const)("records a %s update once, when the overview sees it, and emails the admin an alert", async (result, words) => {
    await withSmtp(async (smtp) => {
      setup.helper.status = (id) => statusFile(id, "verified", null, null, setup.release.keyId);
      const requestId = await accepted();
      writeStatus(statusFile(requestId, "finished", result, "unhealthy", setup.release.keyId));
      expect((await overviewOf(test, cookie)).update).toMatchObject({ phase: "finished", result, reason: "unhealthy" });
      await overviewOf(test, cookie);
      await restart().recordFinished();
      expect(test.audited("update.finished")).toMatchObject([{ outcome: "failed", details: { requestId, result, reason: "unhealthy" } }]);
      await vi.waitFor(() => expect(smtp.received).toHaveLength(1));
      expect(smtp.received[0]?.raw).toContain(words);
      expect(smtp.received[0]?.raw).toContain("didn't stay healthy");
    });
  });

  it("ends an update as download-failed when the server restarted while it downloaded", async () => {
    const { promise: gate, reject: failDownload } = Promise.withResolvers<never>();
    // Handled by the download once it waits on it; this keeps an early rejection from counting as unhandled.
    gate.catch(() => undefined);
    let tarballAsked = false;
    const serve = setup.github.fetch;
    const restarted = buildTestApp({
      config: { updateCheck: true, updateFromUi: true },
      updates: {
        ...setup.options,
        fetch: async (url, init) => {
          if (!url.includes(".tar.gz")) return serve(url, init);
          tarballAsked = true;
          return gate;
        },
      },
    });
    const other = await restarted;
    try {
      const otherAdmin = await other.createAdmin();
      const otherCookie = await other.signIn(otherAdmin.username);
      await callRoute(other, routes.checkForUpdates, { cookie: otherCookie });
      const response = await callRoute(other, routes.installUpdate, {
        cookie: otherCookie,
        payload: { version: LATEST, reauthentication: { password: goodPassword, secondFactor: { code: other.totpCode(otherAdmin.id) } } },
      });
      expect(response.statusCode).toBe(202);
      const { requestId } = response.json<{ requestId: string }>();
      await vi.waitFor(() => expect(tarballAsked).toBe(true));
      expect((await overviewOf(other, otherCookie)).update).toMatchObject({ requestId, phase: "downloading", result: null });
      // A second request while it downloads is refused.
      const again = await callRoute(other, routes.installUpdate, {
        cookie: otherCookie,
        payload: { version: LATEST, reauthentication: { password: goodPassword, secondFactor: { code: other.totpCode(otherAdmin.id) } } },
      });
      expectProblem(again, 409, problemTypes.updateInProgress);

      // The server that starts next over the same database finds it never handed over.
      const next = createTestServices(other.database, other.clock, silentLogger, undefined, testResourceRoots, {
        updates: { ...setup.options, check: true, fromUi: true },
      }).updates;
      await next.recordFinished();
      expect(other.audited("update.finished")).toMatchObject([{ details: { requestId, result: "refused", reason: "download-failed" } }]);
      expect((await next.overview()).update).toMatchObject({ requestId, phase: "finished", result: "refused", reason: "download-failed" });

      // The old one's own end of it changes nothing more.
      failDownload(new Error("stopped"));
      await other.services.updates.settled();
      expect(other.audited("update.finished")).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  /** A request its server accepted, then stopped with while the verify unit ran: never handed over, not active here. */
  const stoppedWhileVerifying = (): string => {
    const requestId = "01900000-0000-7000-8000-0000000000aa";
    test.database.db
      .insert(updateRequests)
      .values({
        requestId,
        accountId: admin.id,
        username: admin.username,
        fromVersion: RUNNING,
        toVersion: LATEST,
        startedAt: "2026-11-24T10:16:00.000Z",
        handedOverAt: null,
        result: null,
        reason: null,
        finishedAt: null,
        recordedAt: null,
      })
      .run();
    return requestId;
  };

  it("leaves an update alone, shown as verifying, while the verify unit a stopped server started still runs", async () => {
    const requestId = stoppedWhileVerifying();
    setup.helper.running = true;
    for (let i = 0; i < 2; i++) {
      await test.services.updates.recordFinished();
      expect((await overviewOf(test, cookie)).update).toEqual({
        requestId,
        from: RUNNING,
        to: LATEST,
        phase: "verifying",
        result: null,
        reason: null,
        startedAt: "2026-11-24T10:16:00.000Z",
        finishedAt: null,
      });
    }
    expect(test.audited("update.finished")).toEqual([]);
    expect(tableRows(test, "update_requests")).toMatchObject([{ request_id: requestId, result: null, recorded_at: null }]);
  });

  it("records the status the verify unit wrote once it has ended, whichever way it ended", async () => {
    const requestId = stoppedWhileVerifying();
    setup.helper.running = true;
    await test.services.updates.recordFinished();
    expect(test.audited("update.finished")).toEqual([]);

    setup.helper.running = false;
    writeStatus(statusFile(requestId, "finished", "refused", "unsigned", setup.release.keyId));
    await test.services.updates.recordFinished();
    await test.services.updates.recordFinished();
    expect(test.audited("update.finished")).toMatchObject([
      {
        actorUsername: "admin",
        outcome: "failed",
        details: { requestId, from: RUNNING, to: LATEST, result: "refused", reason: "unsigned", signingKey: setup.release.keyId },
      },
    ]);
    expect((await overviewOf(test, cookie)).update).toMatchObject({ requestId, phase: "finished", result: "refused", reason: "unsigned" });
  });

  it("ends an update as download-failed once the verify unit has ended without taking it", async () => {
    const requestId = stoppedWhileVerifying();
    setup.helper.running = true;
    await test.services.updates.recordFinished();
    expect(test.audited("update.finished")).toEqual([]);

    // A status file of another request doesn't say anything about this one.
    setup.helper.running = false;
    writeStatus(statusFile("01900000-0000-7000-8000-0000000000bb", "finished", "succeeded"));
    await test.services.updates.recordFinished();
    await test.services.updates.recordFinished();
    expect(test.audited("update.finished")).toMatchObject([
      { outcome: "failed", details: { requestId, result: "refused", reason: "download-failed", signingKey: null } },
    ]);
    expect((await overviewOf(test, cookie)).update).toMatchObject({
      requestId,
      phase: "finished",
      result: "refused",
      reason: "download-failed",
    });
  });

  it("doesn't ask whether the verify unit runs for a request that was handed over or has a status", async () => {
    const isRunning = vi.spyOn(setup.helper, "isRunning");
    setup.helper.status = (id) => statusFile(id, "verified", null, null, setup.release.keyId);
    const requestId = await accepted();
    await restart().recordFinished();
    expect((await overviewOf(test, cookie)).update).toMatchObject({ requestId, phase: "verified" });

    writeStatus(statusFile(requestId, "finished", "succeeded", null, setup.release.keyId));
    await restart().recordFinished();
    expect(test.audited("update.finished")).toHaveLength(1);
    expect(isRunning).not.toHaveBeenCalled();
  });

  it("records an install that ends in an unexpected error as update.requested with the outcome error, and rethrows it", async () => {
    stoppedWhileVerifying();
    setup.helper.isRunning = async () => {
      throw new Error("systemd went away");
    };
    expectProblem(await install(), 500, problemTypes.internalError);
    expect(test.audited("update.requested")).toMatchObject([
      {
        actorUsername: "admin",
        outcome: "failed",
        details: { requestId: expect.any(String), from: RUNNING, to: LATEST, outcome: "error" },
      },
    ]);
    expect(setup.helper.runs).toEqual([]);
    expect(setup.github.requests).toEqual([]);
    expect(tableRows(test, "update_requests")).toHaveLength(1);
  });

  it("never trusts a status file that doesn't parse: shown as unknown, no finish recorded, no update blocked", async () => {
    setup.helper.status = (id) => statusFile(id, "verified");
    const requestId = await accepted();
    for (const garbage of [
      "{",
      JSON.stringify({ ...statusFile(requestId, "finished", "succeeded"), extra: 1 }),
      JSON.stringify({ ...statusFile(requestId, "finished", "succeeded"), reason: "unhealthy" }),
    ]) {
      writeStatus(garbage);
      expect((await overviewOf(test, cookie)).update).toMatchObject({ requestId, phase: "verified", result: null });
      await restart().recordFinished();
    }
    expect(test.audited("update.finished")).toEqual([]);

    // A status file that doesn't parse doesn't say an update is in progress either; the helper's lock decides.
    setup.helper.status = undefined;
    expect((await install()).statusCode).toBe(202);
  });
});
