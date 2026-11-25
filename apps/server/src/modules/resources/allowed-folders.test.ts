import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { problemTypes, routes, type PasskeyRequestOptions } from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addPasskeyInSettings,
  asRealPath,
  buildTestApp,
  createSoftwarePasskey,
  expectProblem,
  goodPassword,
  makeStorageRoot,
  startFakeSmtp,
  type FakeSmtp,
  type TestApp,
} from "../../test-support/index.ts";
import { callRoute } from "../../test-support/sessions.ts";
import type { AccountRecord } from "../accounts/index.ts";
import { fixRoot, type FixedRoot } from "../storage/index.ts";
import { ALLOW_FOLDER_LIMIT, FOLDER_REQUEST_FILE, type FolderHelper, type FolderHelperOutcome } from "./index.ts";

/** Folders whose path holds this text answer `not-writable`, and this one that the service can write to already. */
const NOT_WRITABLE = "read-only";
const WRITABLE = "already-writable";

const fakeFixRoot = async (absolute: string): Promise<FixedRoot> => {
  if (absolute.includes(NOT_WRITABLE)) return { ok: false, reason: "not-writable" };
  if (absolute.includes(WRITABLE)) return { ok: true, realPath: asRealPath(absolute) };
  return fixRoot(absolute);
};

/** What the helper found when it ran: the request file's content and modes. */
interface HelperRun {
  readonly content: string;
  readonly fileMode: number;
  readonly dirMode: number;
}

/** A helper that needs no root: it answers `outcome` and keeps what it found. */
function fakeFolderHelper(requestsDir: string): FolderHelper & { outcome: FolderHelperOutcome; readonly runs: HelperRun[] } {
  const runs: HelperRun[] = [];
  return {
    outcome: { ok: true },
    runs,
    async allow() {
      const file = join(requestsDir, FOLDER_REQUEST_FILE);
      runs.push({
        content: readFileSync(file, "utf8"),
        fileMode: statSync(file).mode & 0o777,
        dirMode: statSync(requestsDir).mode & 0o777,
      });
      return this.outcome;
    },
  };
}

describe("allowing a folder from the admin interface, switched off", () => {
  let test: TestApp;

  beforeEach(async () => {
    test = await buildTestApp({ resourceRoots: { dataDir: "/nonexistent/not-unreachable", fixRoot: fakeFixRoot } });
  });
  afterEach(() => test.close());

  it("doesn't exist, for the admin as for anyone, and no folder is said to be allowable", async () => {
    const cookie = await test.signIn((await test.createAdmin()).username);
    const payload = { localPath: "/srv/read-only", reauthentication: { password: goodPassword, secondFactor: { code: "123456" } } };
    expectProblem(await callRoute(test, routes.allowFolder, { cookie, payload }), 404, problemTypes.notFound);
    expectProblem(await callRoute(test, routes.allowFolder, { payload }), 404, problemTypes.notFound);
    expect(
      (await callRoute(test, routes.checkResource, { cookie, payload: { kind: "local", localPath: "/srv/read-only" } })).json(),
    ).toMatchObject({ outcome: "refused", reason: "not-writable", allowFromUi: false });
    expect(test.audited("folder.allowed")).toEqual([]);
  });
});

describe("allowing a folder from the admin interface", () => {
  // Below /srv rather than the temp folder: /tmp is a system folder, which the admin interface never allows.
  const prefix = `/srv/nu-test-${randomUUID()}`;
  const allowable = `${prefix}/photos-${NOT_WRITABLE}`;
  let storage: ReturnType<typeof makeStorageRoot>;
  let requestsDir: string;
  let helper: ReturnType<typeof fakeFolderHelper>;
  let test: TestApp;
  let admin: AccountRecord;
  let cookie: string;

  beforeEach(async () => {
    storage = makeStorageRoot();
    requestsDir = join(storage.dir, "folder-requests");
    helper = fakeFolderHelper(requestsDir);
    test = await buildTestApp({
      config: { allowFoldersFromUi: true, allowedFolderPrefixes: [prefix] },
      resourceRoots: { dataDir: join(prefix, "data"), fixRoot: fakeFixRoot, folderRequestsDir: requestsDir, folderHelper: helper },
    });
    admin = await test.createAdmin();
    cookie = await test.signIn(admin.username);
  });
  afterEach(async () => {
    await test.close();
    storage.cleanup();
  });

  const bothFactors = () => ({ password: goodPassword, secondFactor: { code: test.totpCode(admin.id) } });
  const allow = (localPath: string, reauthentication: object = bothFactors(), as = cookie) =>
    callRoute(test, routes.allowFolder, { cookie: as, payload: { localPath, reauthentication } });
  const results = () => test.audited("folder.allowed").map((event) => event.details["result"]);

  it("says a folder the service can't write to is allowable once it passes the rules, also when Add refuses it", async () => {
    expect((await callRoute(test, routes.checkResource, { cookie, payload: { kind: "local", localPath: allowable } })).json()).toEqual({
      outcome: "refused",
      reason: "not-writable",
      command: `sudo not-unreachable allow-folder ${allowable}`,
      allowFromUi: true,
    });
    const refused = expectProblem(
      await callRoute(test, routes.addResource, { cookie, payload: { kind: "local", name: "Photos", localPath: allowable } }),
      422,
      problemTypes.folderRefused,
    );
    expect(refused).toMatchObject({ reason: "not-writable", allowFromUi: true });
    const outside = await callRoute(test, routes.checkResource, { cookie, payload: { kind: "local", localPath: `/mnt/${NOT_WRITABLE}` } });
    expect(outside.json()).toMatchObject({ reason: "not-writable", allowFromUi: false });
  });

  it("writes the request 0600, starts the helper, deletes the request, answers 202 and records it", async () => {
    const smtp: FakeSmtp = await startFakeSmtp();
    try {
      const mail = { host: "127.0.0.1", port: smtp.port, tlsMode: "none", username: null, fromAddress: "noreply@example.com" };
      expect((await callRoute(test, routes.updateMailSettings, { cookie, payload: mail })).statusCode).toBe(200);

      const response = await allow(`  ${allowable}`);
      expect(response.statusCode).toBe(202);
      expect(response.body).toBe("");
      expect(helper.runs).toEqual([{ content: JSON.stringify({ path: allowable }), fileMode: 0o600, dirMode: 0o700 }]);
      expect(existsSync(join(requestsDir, FOLDER_REQUEST_FILE))).toBe(false);
      expect(test.audited("folder.allowed")).toMatchObject([
        {
          actorUsername: "admin",
          outcome: "succeeded",
          details: { path: allowable, realPath: allowable, result: "allowed" },
        },
      ]);
      expect(test.logs()).toContainEqual(expect.objectContaining({ msg: expect.stringContaining("A folder was allowed") }));
      expect(JSON.stringify(test.logs())).not.toContain(goodPassword);
      await vi.waitFor(() => expect(smtp.received).toHaveLength(1));
      expect(smtp.received[0]).toMatchObject({ to: ["admin@example.com"] });
      expect(smtp.received[0]?.raw).toContain("A folder was allowed");
    } finally {
      await smtp.close();
    }
  });

  it("takes a passkey over the confirm challenge as the second factor", async () => {
    const phone = createSoftwarePasskey();
    await addPasskeyInSettings(test, cookie, phone);
    const options = (await callRoute(test, routes.startPasskeyConfirmation, { cookie })).json<PasskeyRequestOptions>();
    const response = await allow(allowable, { password: goodPassword, secondFactor: { passkey: phone.assert(options) } });
    expect(response.statusCode).toBe(202);
    expect(helper.runs).toHaveLength(1);
  });

  it("refuses a request without both factors with 400", async () => {
    for (const reauthentication of [undefined, { password: goodPassword }, { password: goodPassword, secondFactor: {} }]) {
      const payload = { localPath: allowable, ...(reauthentication === undefined ? {} : { reauthentication }) };
      expectProblem(await callRoute(test, routes.allowFolder, { cookie, payload }), 400, problemTypes.validationFailed);
    }
    expect(helper.runs).toEqual([]);
    expect(test.audited("folder.allowed")).toEqual([]);
  });

  it("answers a wrong password 401 sign-in-failed before looking at the second factor or the folder", async () => {
    expectProblem(
      await allow(`${prefix}/nope`, { password: "not the password", secondFactor: { code: test.totpCode(admin.id) } }),
      401,
      problemTypes.signInFailed,
    );
    expect(test.audited("folder.allowed")).toMatchObject([
      { outcome: "failed", details: { path: `${prefix}/nope`, realPath: null, result: "wrong-password" } },
    ]);
    expect(test.audited("sign-in.failed")).toHaveLength(1);
    expect(test.audited("second-factor.failed")).toEqual([]);
    expect(helper.runs).toEqual([]);
  });

  it("answers the right password with a wrong code 401 second-factor-failed", async () => {
    const code = test.totpCode(admin.id);
    const wrong = `${code.slice(0, 5)}${(Number(code.at(5)) + 5) % 10}`;
    expectProblem(await allow(allowable, { password: goodPassword, secondFactor: { code: wrong } }), 401, problemTypes.secondFactorFailed);
    expect(test.audited("folder.allowed")).toMatchObject([{ outcome: "failed", details: { result: "wrong-second-factor" } }]);
    expect(test.audited("second-factor.failed")).toMatchObject([{ details: { method: "totp", during: "confirm" } }]);
    expect(helper.runs).toEqual([]);
  });

  it.each([
    ["outside the allowed folders", (): string => `/mnt/nu-test/${NOT_WRITABLE}`, "outside-allowed-folders"],
    ["in a system folder", (): string => join(storage.dir, NOT_WRITABLE), "system-folder"],
    [
      "escaping through a symlink",
      (): string => {
        symlinkSync("/etc", join(storage.dir, `${NOT_WRITABLE}-link`));
        return join(storage.dir, `${NOT_WRITABLE}-link`);
      },
      "system-folder",
    ],
    ["inside the data directory", (): string => `${prefix}/data/${NOT_WRITABLE}`, "inside-data-directory"],
    ["missing", (): string => `${prefix}/nope`, "missing"],
    ["relative", (): string => `srv/${NOT_WRITABLE}`, "not-absolute"],
    ["not listable in the drop-in", (): string => `${prefix}/${NOT_WRITABLE}"x`, "unsupported-path"],
  ] as const)("refuses a folder %s with 422 and never starts the helper", async (_case, make, reason) => {
    const localPath = make();
    const problem = expectProblem(await allow(localPath), 422, problemTypes.folderNotAllowable);
    expect(problem).toMatchObject({ reason });
    expect(JSON.stringify(problem)).not.toContain(localPath);
    expect(helper.runs).toEqual([]);
    expect(test.audited("folder.allowed")).toMatchObject([{ outcome: "denied", details: { path: localPath, result: reason } }]);
  });

  it("answers 409 for a folder the service can write to already", async () => {
    const localPath = `${prefix}/${WRITABLE}`;
    expectProblem(await allow(localPath), 409, problemTypes.badRequest);
    expect(helper.runs).toEqual([]);
    expect(test.audited("folder.allowed")).toMatchObject([
      { outcome: "denied", details: { realPath: localPath, result: "already-writable" } },
    ]);
  });

  it("answers what the helper refused with 422 and its reason", async () => {
    helper.outcome = { ok: false, reason: "outside-allowed-folders" };
    expect(expectProblem(await allow(allowable), 422, problemTypes.folderNotAllowable)).toMatchObject({
      reason: "outside-allowed-folders",
    });
    expect(existsSync(join(requestsDir, FOLDER_REQUEST_FILE))).toBe(false);
    expect(results()).toEqual(["outside-allowed-folders"]);
  });

  it("answers 503 with what to run on the server when the helper isn't set up, and 500 when it failed", async () => {
    helper.outcome = { ok: false, reason: "helper-unavailable" };
    const unavailable = expectProblem(await allow(allowable), 503, problemTypes.serviceUnavailable);
    expect(unavailable.detail).toContain("sudo not-unreachable allow-folders-from-ui on");
    expect(unavailable.detail).toContain("sudo not-unreachable allow-folder");
    expect(JSON.stringify(unavailable)).not.toContain(allowable);

    helper.outcome = { ok: false, reason: "helper-failed" };
    expectProblem(await allow(allowable), 500, problemTypes.internalError);
    expect(existsSync(join(requestsDir, FOLDER_REQUEST_FILE))).toBe(false);
    expect(test.audited("folder.allowed").map((event) => [event.outcome, event.details["result"]])).toEqual([
      ["failed", "helper-failed"],
      ["failed", "helper-unavailable"],
    ]);
  });

  it("records a request that ends in an unexpected error, and deletes the request file", async () => {
    vi.spyOn(helper, "allow").mockRejectedValueOnce(new Error("systemctl vanished"));
    expectProblem(await allow(allowable), 500, problemTypes.internalError);
    expect(existsSync(join(requestsDir, FOLDER_REQUEST_FILE))).toBe(false);
    expect(test.audited("folder.allowed")).toMatchObject([
      { outcome: "failed", details: { path: allowable, realPath: allowable, result: "error" } },
    ]);
  });

  it(`answers 429 past ${ALLOW_FOLDER_LIMIT.max} requests in 15 minutes per admin, and records it`, async () => {
    for (let i = 0; i < ALLOW_FOLDER_LIMIT.max; i++) {
      expectProblem(await allow(`/mnt/nu-test/${NOT_WRITABLE}`), 422, problemTypes.folderNotAllowable);
    }
    const limited = await allow(allowable);
    expectProblem(limited, 429, problemTypes.rateLimited);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(test.audited("folder.allowed")[0]).toMatchObject({ outcome: "denied", details: { result: "rate-limited" } });
    expect(helper.runs).toEqual([]);

    test.clock.advance(ALLOW_FOLDER_LIMIT.windowMs);
    cookie = await test.signIn(admin.username);
    expect((await allow(allowable)).statusCode).toBe(202);
  });

  it("is for the admin only", async () => {
    const userCookie = test.startSession(test.createUser());
    expectProblem(await allow(allowable, bothFactors(), userCookie), 403, problemTypes.forbidden);
    expectProblem(await allow(allowable, bothFactors(), ""), 401, problemTypes.signInRequired);
    expect(helper.runs).toEqual([]);
    expect(test.audited("folder.allowed")).toEqual([]);
  });
});
