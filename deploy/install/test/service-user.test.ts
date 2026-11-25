import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installScript, makeBundle, readRepoFile, run, sourced, temporaryDirectory } from "./support.ts";

const ORIGIN = "https://files.example.com";
const SYSUSERS_FILE = "usr/lib/sysusers.d/not-unreachable.conf";

function install(bundle: string, destdir: string, args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  return run("bash", [join(bundle, "install.sh"), "--public-origin", ORIGIN, ...args], { env: { DESTDIR: destdir, ...env } });
}

/** Runs the installer on a terminal (util-linux `script`), typing `input` into it. */
function installOnTerminal(bundle: string, destdir: string, input: string) {
  const command = `bash ${join(bundle, "install.sh")} --public-origin ${ORIGIN}`;
  return run("script", ["--quiet", "--return", "--command", command, "/dev/null"], { env: { DESTDIR: destdir }, input });
}

function installedIds(root: string): { uid: string; gid: string } {
  const file = readFileSync(join(root, SYSUSERS_FILE), "utf8");
  return {
    uid: /^u not-unreachable (\d+):not-unreachable /mu.exec(file)?.[1] ?? "",
    gid: /^g not-unreachable (\d+)$/mu.exec(file)?.[1] ?? "",
  };
}

describe("the service user's ID in a DESTDIR install", () => {
  it("is 2000 by default, with only the IDs of the tarball's sysusers file changed", () => {
    const root = temporaryDirectory();
    const installed = install(makeBundle("1.0.0"), root, ["--yes"]);
    expect(installed.stderr).toBe("");
    expect(installed.status).toBe(0);
    expect(readFileSync(join(root, SYSUSERS_FILE), "utf8")).toBe(readRepoFile("deploy/sysusers/not-unreachable.conf"));
    expect(installed.stdout).toContain("The service user not-unreachable gets UID 2000 and GID 2000");
    expect(installed.stdout).toContain("The service user not-unreachable has UID 2000 and GID 2000");
  });

  it("is the one --uid or NU_UID names, --uid first", () => {
    const bundle = makeBundle("1.0.0");
    const byOption = temporaryDirectory();
    expect(install(bundle, byOption, ["--uid", "3000", "--yes"]).status).toBe(0);
    expect(installedIds(byOption)).toEqual({ uid: "3000", gid: "3000" });

    const byVariable = temporaryDirectory();
    expect(install(bundle, byVariable, ["--yes"], { NU_UID: "3001" }).status).toBe(0);
    expect(installedIds(byVariable)).toEqual({ uid: "3001", gid: "3001" });

    const both = temporaryDirectory();
    expect(install(bundle, both, ["--uid=3002", "--yes"], { NU_UID: "3001" }).status).toBe(0);
    expect(installedIds(both)).toEqual({ uid: "3002", gid: "3002" });
  });

  it.each(["0", "-1", "60001", "65534", "2000a", "02000"])("refuses --uid %j before laying anything out", (id) => {
    const root = temporaryDirectory();
    const refused = install(makeBundle("1.0.0"), root, [`--uid=${id}`, "--yes"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("--uid (or NU_UID) must be a number from 1 to 60000");
    expect(run("find", [root, "-mindepth", "1"]).stdout).toBe("");
  });

  it("is asked on a terminal, 2000 when the answer is empty, again when it is not a valid ID", () => {
    const bundle = makeBundle("1.0.0");
    const defaulted = temporaryDirectory();
    const empty = installOnTerminal(bundle, defaulted, "\n\n");
    expect(empty.stdout).toContain("UID and GID of the service user [2000]:");
    expect(empty.status).toBe(0);
    expect(installedIds(defaulted)).toEqual({ uid: "2000", gid: "2000" });

    const chosen = temporaryDirectory();
    const retried = installOnTerminal(bundle, chosen, "abc\n4000\n\n");
    expect(retried.stdout).toContain('"abc" is not a number from 1 to 60000');
    expect(retried.status).toBe(0);
    expect(installedIds(chosen)).toEqual({ uid: "4000", gid: "4000" });
  });

  it("is kept on an upgrade, which asks nothing and says when another ID was asked for", () => {
    const root = temporaryDirectory();
    expect(install(makeBundle("1.0.0"), root, ["--uid", "3000", "--yes"]).status).toBe(0);
    const upgraded = installOnTerminal(makeBundle("1.1.0"), root, "");
    expect(upgraded.status).toBe(0);
    expect(upgraded.stdout).not.toContain("UID and GID of the service user [");
    expect(upgraded.stdout).toContain("Keeping the service user not-unreachable with UID 3000 and GID 3000");
    expect(installedIds(root)).toEqual({ uid: "3000", gid: "3000" });

    const other = install(makeBundle("1.2.0"), root, ["--yes"], { NU_UID: "2000" });
    expect(other.status).toBe(0);
    expect(other.stderr).toContain("keeps UID 3000 and GID 3000, not 2000");
    expect(installedIds(root)).toEqual({ uid: "3000", gid: "3000" });
  });

  it("refuses a tarball whose sysusers file has no fixed IDs to fill in", () => {
    const bundle = makeBundle("1.0.0");
    writeFileSync(join(bundle, "deploy/sysusers/not-unreachable.conf"), 'u not-unreachable - "x" / /usr/sbin/nologin\n');
    const refused = install(bundle, temporaryDirectory(), ["--yes"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("has no g and u line for not-unreachable");
  });
});

/**
 * Runs choose_service_id on a host whose users and groups are `passwd` and `group` (getent's lines),
 * then prints the chosen IDs.
 */
function choose(options: { passwd?: string[]; group?: string[]; requested?: string } = {}) {
  const work = temporaryDirectory();
  const passwd = join(work, "passwd");
  const group = join(work, "group");
  writeFileSync(passwd, (options.passwd ?? []).map((line) => `${line}\n`).join(""));
  writeFileSync(group, (options.group ?? []).map((line) => `${line}\n`).join(""));
  // getent answers a name or an ID from the stand-in files, and fails (2) on no match, as it does.
  const getent = `getent() {
    local file; case "$1" in passwd) file="${passwd}" ;; group) file="${group}" ;; esac
    awk -F: -v key="$2" '$1 == key || $3 == key { print; found = 1 } END { exit found ? 0 : 2 }' "$file"
  }`;
  return sourced(
    installScript,
    `${getent}; ASSUME_YES=true; REQUESTED_SERVICE_ID="${options.requested ?? ""}"; choose_service_id; printf '%s %s\\n' "$SERVICE_UID" "$SERVICE_GID"`,
  );
}

const SERVICE_USER = (uid: number, gid: number) => `not-unreachable:x:${uid}:${gid}:NotUnreachable file sharing:/:/usr/sbin/nologin`;

describe("choosing the service user's ID on a host", () => {
  it("takes 2000, or the one asked for, when the IDs are free", () => {
    expect(choose().stdout).toMatch(/2000 2000\n$/u);
    expect(choose({ requested: "2500" }).stdout).toMatch(/2500 2500\n$/u);
  });

  it("keeps an existing service user's UID and GID, and says so when another was asked for", () => {
    const kept = choose({ passwd: [SERVICE_USER(989, 985)], group: ["not-unreachable:x:985:"], requested: "2000" });
    expect(kept.status).toBe(0);
    expect(kept.stdout).toMatch(/Keeping the service user not-unreachable with UID 989 and GID 985\n989 985\n$/u);
    expect(kept.stderr).toContain("keeps UID 989 and GID 985, not 2000");
    expect(kept.stderr).toContain("Changing the service user's ID");

    const same = choose({ passwd: [SERVICE_USER(2000, 2000)], requested: "2000" });
    expect(same.stderr).toBe("");
  });

  it("stops when another user has the UID or another group the GID", () => {
    const user = choose({ passwd: ["alice:x:2000:2000::/home/alice:/bin/bash"] });
    expect(user.status).toBe(1);
    expect(user.stderr).toContain("UID 2000 is already the user alice's: choose another ID with --uid or NU_UID. Nothing was changed.");

    const group = choose({ group: ["media:x:2000:"] });
    expect(group.status).toBe(1);
    expect(group.stderr).toContain("GID 2000 is already the group media's");
  });

  it("joins a group named like the service user that is left without it, with that group's GID", () => {
    const joined = choose({ group: ["not-unreachable:x:1500:"] });
    expect(joined.status).toBe(0);
    expect(joined.stderr).toContain("the group not-unreachable exists already with GID 1500");
    expect(joined.stdout).toMatch(/2000 1500\n$/u);
  });
});
