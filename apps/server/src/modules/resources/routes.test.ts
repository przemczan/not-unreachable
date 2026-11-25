import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  homeRootSchema,
  localResourceSchema,
  problemMediaType,
  problemSchema,
  problemTypes,
  resourceListSchema,
  routes,
  smbResourceSchema,
  type RouteContract,
} from "@not-unreachable/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECENT_SIGN_IN_MS } from "../../http/index.ts";
import {
  buildTestApp,
  expectProblem,
  fakeMountRunner,
  makeStorageRoot,
  writeMountInfo,
  type FakeMountRunner,
  type TestApp,
} from "../../test-support/index.ts";
import { callRoute } from "../../test-support/sessions.ts";
import { fixRoot, type FixedRoot } from "../storage/index.ts";

const resourceKeys = Object.keys(localResourceSchema.shape).toSorted();

describe("the resources routes", () => {
  let storage: ReturnType<typeof makeStorageRoot>;
  let test: TestApp;
  let cookie: string;
  /** Folders whose path holds this text answer `not-writable`. */
  const NOT_WRITABLE = "read-only";

  beforeEach(async () => {
    storage = makeStorageRoot();
    test = await buildTestApp({
      resourceRoots: {
        dataDir: join(storage.dir, "data"),
        fixRoot: async (absolute): Promise<FixedRoot> =>
          absolute.includes(NOT_WRITABLE) ? { ok: false, reason: "not-writable" } : fixRoot(absolute),
      },
    });
    cookie = await test.signIn((await test.createAdmin()).username);
  });
  afterEach(async () => {
    await test.close();
    storage.cleanup();
  });

  const folder = (name: string): string => {
    const path = join(storage.dir, name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  const call = (route: Pick<RouteContract, "method" | "path">, options: { payload?: object; params?: string; cookie?: string } = {}) =>
    callRoute(test, route, { cookie, ...options });
  const add = async (name: string, path = folder(name)) => {
    const response = await call(routes.addResource, { payload: { kind: "local", name, localPath: path } });
    expect(response.statusCode).toBe(201);
    return localResourceSchema.parse(response.json());
  };

  /** A valid request for every route, so only the guard can refuse it. */
  function everyRoute(id: string) {
    return [
      [routes.listResources, {}],
      [routes.addResource, { payload: { kind: "local", name: "X", localPath: folder("x") } }],
      [routes.getResource, { params: id }],
      [routes.changeResource, { params: id, payload: { kind: "local", name: "Y" } }],
      [routes.removeResource, { params: id }],
      [routes.retryResource, { params: id }],
      [routes.checkResource, { payload: { kind: "local", localPath: folder("x") } }],
      [routes.setHomeRoot, { payload: { resourceId: id, subpath: "" } }],
    ] as const;
  }

  it("refuses every route to anonymous callers and to users", async () => {
    const { id } = await add("Files");
    const userCookie = test.startSession(test.createUser());
    for (const [route, options] of everyRoute(id)) {
      expectProblem(await call(route, { ...options, cookie: "" }), 401, problemTypes.signInRequired);
      expectProblem(await call(route, { ...options, cookie: userCookie }), 403, problemTypes.forbidden);
    }
    expect(test.audited("resource.removed")).toEqual([]);
  });

  it("adds, lists, gets, changes, retries and removes a resource with exactly the contract's fields", async () => {
    const added = await add("Files");
    expect(Object.keys(added).toSorted()).toEqual(resourceKeys);
    expect(added).toMatchObject({ kind: "local", name: "Files", state: "available", isHomeRoot: false });

    const list = await call(routes.listResources);
    expect(list.statusCode).toBe(200);
    expect(resourceListSchema.parse(list.json())).toEqual({ resources: [added], homeRoot: null });

    const got = await call(routes.getResource, { params: added.id });
    expect(Object.keys(got.json()).toSorted()).toEqual(resourceKeys);

    const changed = await call(routes.changeResource, { params: added.id, payload: { kind: "local", name: "Shared" } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ ...added, name: "Shared" });

    const retried = await call(routes.retryResource, { params: added.id });
    expect(retried.statusCode).toBe(200);
    expect(Object.keys(retried.json()).toSorted()).toEqual(resourceKeys);

    const removed = await call(routes.removeResource, { params: added.id });
    expect(removed.statusCode).toBe(204);
    expect(removed.body).toBe("");
    expectProblem(await call(routes.getResource, { params: added.id }), 404, problemTypes.notFound);

    expect(test.audited().map((event) => event.action)).toEqual(
      expect.arrayContaining(["resource.added", "resource.changed", "resource.removed"]),
    );
    expect(test.audited("resource.added")).toHaveLength(1);
    expect(test.audited("resource.changed")).toHaveLength(1);
    expect(test.audited("resource.removed")).toHaveLength(1);
  });

  it("answers a refused folder with problem+json 422, its reason and the command", async () => {
    const path = folder(NOT_WRITABLE);
    const response = await call(routes.addResource, { payload: { kind: "local", name: "X", localPath: path } });
    expect(response.statusCode).toBe(422);
    expect(response.headers["content-type"]).toBe(`${problemMediaType}; charset=utf-8`);
    expect(problemSchema.parse(response.json())).toEqual({
      type: problemTypes.folderRefused,
      title: expect.any(String),
      status: 422,
      detail: expect.stringContaining(`sudo not-unreachable allow-folder ${path}`),
      reason: "not-writable",
      command: `sudo not-unreachable allow-folder ${path}`,
      allowFromUi: false,
    });

    const inside = expectProblem(
      await call(routes.addResource, { payload: { kind: "local", name: "X", localPath: join(storage.dir, "data", "x") } }),
      422,
      problemTypes.folderRefused,
    );
    expect(inside).toMatchObject({ reason: "inside-data-directory" });
    expect(inside).not.toHaveProperty("command");

    const check = await call(routes.checkResource, { payload: { kind: "local", localPath: path } });
    expect(check.statusCode).toBe(200);
    expect(check.json()).toEqual({
      outcome: "refused",
      reason: "not-writable",
      command: `sudo not-unreachable allow-folder ${path}`,
      allowFromUi: false,
    });
    expect((await call(routes.checkResource, { payload: { kind: "local", localPath: folder("fine") } })).json()).toEqual({ outcome: "ok" });
    expect(test.audited("resource.added")).toEqual([]);
  });

  it("answers a taken name with 409 and an unknown resource with 404", async () => {
    await add("Files");
    expectProblem(
      await call(routes.addResource, { payload: { kind: "local", name: "Files", localPath: folder("other") } }),
      409,
      problemTypes.resourceNameTaken,
    );
    expectProblem(await call(routes.changeResource, { payload: { kind: "local", name: "Y" } }), 404, problemTypes.notFound);
    expectProblem(await call(routes.retryResource), 404, problemTypes.notFound);
    expectProblem(await call(routes.removeResource), 404, problemTypes.notFound);
  });

  it("sets the home root, refuses to remove its resource and refuses a bad subpath", async () => {
    const files = await add("Files");
    const response = await call(routes.setHomeRoot, { payload: { resourceId: files.id, subpath: "homes" } });
    expect(response.statusCode).toBe(200);
    expect(homeRootSchema.parse(response.json())).toEqual({ resourceId: files.id, subpath: "homes" });
    expect(existsSync(join(storage.dir, "Files", "homes"))).toBe(true);
    expect(test.audited("home-root.changed")).toHaveLength(1);

    const inUse = expectProblem(await call(routes.removeResource, { params: files.id }), 409, problemTypes.homeRootResource);
    expect(inUse).toMatchObject({ reason: "home-root", detail: expect.stringContaining("home root") });

    const refused = expectProblem(
      await call(routes.setHomeRoot, { payload: { resourceId: files.id, subpath: "../up" } }),
      422,
      problemTypes.pathRefused,
    );
    expect(refused).toMatchObject({ reason: "invalid" });
    writeFileSync(join(storage.dir, "Files", "a-file"), "x");
    expect(
      expectProblem(
        await call(routes.setHomeRoot, { payload: { resourceId: files.id, subpath: "a-file/x" } }),
        422,
        problemTypes.pathRefused,
      ),
    ).toMatchObject({ reason: "not-a-folder" });
    expectProblem(await call(routes.setHomeRoot, { payload: { subpath: "" } }), 400, problemTypes.validationFailed);
  });

  it("answers an unavailable resource with 409", async () => {
    const files = await add("Files", folder("gone"));
    storage.cleanup();
    await test.services.resources.checkAtStartup();
    expectProblem(
      await call(routes.setHomeRoot, { payload: { resourceId: files.id, subpath: "" } }),
      409,
      problemTypes.resourceUnavailable,
    );
    expect((await call(routes.getResource, { params: files.id })).json()).toMatchObject({
      state: "unavailable",
      unavailableReason: "missing",
    });
  });

  it("needs a recent sign-in to remove a resource or set the home root", async () => {
    const files = await add("Files");
    test.clock.advance(RECENT_SIGN_IN_MS);
    expectProblem(await call(routes.removeResource, { params: files.id }), 403, problemTypes.recentSignInRequired);
    expectProblem(
      await call(routes.setHomeRoot, { payload: { resourceId: files.id, subpath: "" } }),
      403,
      problemTypes.recentSignInRequired,
    );
    expect((await call(routes.changeResource, { params: files.id, payload: { kind: "local", name: "Still" } })).statusCode).toBe(200);
    expect(test.audited("resource.removed")).toEqual([]);
    expect(test.audited("home-root.changed")).toEqual([]);
  });
});

describe("the resources routes for SMB shares", () => {
  const PASSWORD = "s3cret-Pa55word";
  let storage: ReturnType<typeof makeStorageRoot>;
  let runner: FakeMountRunner;
  let test: TestApp;
  let cookie: string;

  beforeEach(async () => {
    storage = makeStorageRoot();
    const mountRoot = join(storage.dir, "mounts");
    const requestsDir = join(storage.dir, "requests");
    mkdirSync(mountRoot);
    writeMountInfo(join(storage.dir, "mountinfo"), []);
    runner = fakeMountRunner({ mountRoot, requestsDir });
    test = await buildTestApp({
      resourceRoots: {
        dataDir: join(storage.dir, "data"),
        mountRoot,
        mountRequestsDir: requestsDir,
        mountInfoPath: join(storage.dir, "mountinfo"),
        mountRunner: runner,
      },
    });
    cookie = await test.signIn((await test.createAdmin()).username);
  });
  afterEach(async () => {
    await test.close();
    storage.cleanup();
  });

  const call = (route: Pick<RouteContract, "method" | "path">, options: { payload?: object; params?: string } = {}) =>
    callRoute(test, route, { cookie, ...options });
  const connection = { kind: "smb", host: "nas.local", share: "Photos", username: "alice" } as const;

  it("never answers the password, and answers a share that won't mount with 422 and its reason", async () => {
    const added = await call(routes.addResource, { payload: { ...connection, name: "NAS", password: PASSWORD } });
    expect(added.statusCode).toBe(201);
    const resource = smbResourceSchema.parse(added.json());
    expect(resource).toMatchObject({ subfolder: "", domain: "", protocol: "3.1.1", encrypt: true, smbPasswordSet: true });

    const bodies = [
      added.body,
      (await call(routes.listResources)).body,
      (await call(routes.getResource, { params: resource.id })).body,
      (await call(routes.changeResource, { params: resource.id, payload: { kind: "smb", password: `${PASSWORD}2` } })).body,
      (await call(routes.retryResource, { params: resource.id })).body,
      (await call(routes.checkResource, { payload: { ...connection, resourceId: resource.id } })).body,
      JSON.stringify(test.audited()),
      JSON.stringify(test.logs()),
    ];
    for (const body of bodies) expect(body).not.toContain(PASSWORD);
    expect(JSON.parse(bodies[5] ?? "")).toEqual({ outcome: "connected", folderCount: 0 });

    runner.failWith = "auth";
    const refused = expectProblem(
      await call(routes.addResource, { payload: { ...connection, name: "Other", password: PASSWORD } }),
      422,
      problemTypes.shareRefused,
    );
    expect(refused).toMatchObject({ reason: "auth" });
    expect((await call(routes.checkResource, { payload: { ...connection, password: PASSWORD } })).json()).toEqual({
      outcome: "failed",
      reason: "auth",
    });
  });

  it("answers 400 when a saved password would go to another server", async () => {
    const added = await call(routes.addResource, { payload: { ...connection, name: "NAS", password: PASSWORD } });
    const { id } = smbResourceSchema.parse(added.json());
    const elsewhere = { ...connection, host: "attacker.example" };
    expectProblem(
      await call(routes.changeResource, { params: id, payload: { kind: "smb", host: elsewhere.host } }),
      400,
      problemTypes.badRequest,
    );
    expectProblem(await call(routes.checkResource, { payload: { ...elsewhere, resourceId: id } }), 400, problemTypes.badRequest);
  });

  it("needs a recent sign-in to remove a share, which then stays mounted", async () => {
    const added = await call(routes.addResource, { payload: { ...connection, name: "NAS", password: PASSWORD } });
    const { id } = smbResourceSchema.parse(added.json());
    test.clock.advance(RECENT_SIGN_IN_MS);
    expectProblem(await call(routes.removeResource, { params: id }), 403, problemTypes.recentSignInRequired);
    expect(runner.active.has(id)).toBe(true);
    expect(runner.calls).not.toContain(`stop ${id}`);
    expect(test.audited("resource.removed")).toEqual([]);
  });
});
