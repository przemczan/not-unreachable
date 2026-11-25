import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readRepoFile, repoRoot, run, sourced, temporaryDirectory, type Run } from "./support.ts";

const bootstrapScript = join(repoRoot, "scripts/release/bootstrap-install.sh");
const arch = process.arch === "arm64" ? "arm64" : "x64";
const otherArch = arch === "x64" ? "arm64" : "x64";

const installed = (command: string): boolean => run("bash", ["-c", `command -v ${command}`]).status === 0;

// A stand-in for the tarball's install.sh: prints what it was given and where its stdin comes from.
const fakeInstaller = `#!/bin/bash
printf 'installer: %s\\n' "$@"
if [[ -t 0 ]]; then echo "stdin: terminal"; else echo "stdin: $(readlink /proc/self/fd/0)"; fi
`;

interface SigningKey {
  readonly id: string;
  readonly privateKey: KeyObject;
  readonly publicKeyPem: string;
}

/** An Ed25519 key pair and its key id: the first 16 hex digits of the SHA-256 of its raw 32 bytes. */
function signingKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
  const id = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return { id, privateKey, publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString() };
}

/** The key the tests' installer trusts in place of the inline ones, and one it doesn't. */
const pinnedKey = signingKey();
const otherPinnedKey = signingKey();
const unpinnedKey = signingKey();

const signatureLine = (key: SigningKey, content: Buffer | string) =>
  `ed25519 ${key.id} ${sign(null, Buffer.from(content), key.privateKey).toString("base64")}\n`;

interface PublishOptions {
  /** Whether it is the latest release; true when left out. */
  readonly latest?: boolean;
  /** The checksum SHA256SUMS lists for every tarball; the right one when left out. */
  readonly checksum?: string;
  readonly archs?: readonly string[];
  /** SHA256SUMS.sig for the SHA256SUMS; signed by the pinned key when left out, none when null. */
  readonly signature?: ((checksums: string) => string) | null;
}

/** A releases folder laid out as GitHub serves them: latest/download/ and download/v<version>/. */
class FakeReleases {
  readonly root = temporaryDirectory();
  private readonly keys = temporaryDirectory();
  readonly downloadsLog = join(temporaryDirectory(), "downloads.log");

  publish(version: string, options: PublishOptions = {}): void {
    const folder = join(this.root, "download", `v${version}`);
    mkdirSync(folder, { recursive: true });
    const checksums = (options.archs ?? [arch, otherArch])
      .map((tarballArch) => {
        const name = `not-unreachable-${version}-linux-${tarballArch}`;
        const tarball = packTarball(name);
        writeFileSync(join(folder, `${name}.tar.gz`), tarball);
        return `${options.checksum ?? createHash("sha256").update(tarball).digest("hex")}  ${name}.tar.gz\n`;
      })
      .join("")
      .concat(`${"e".repeat(64)}  install.sh\n`);
    const signature = options.signature === undefined ? signatureLine(pinnedKey, checksums) : options.signature?.(checksums);
    const folders = [folder, ...((options.latest ?? true) ? [join(this.root, "latest", "download")] : [])];
    for (const target of folders) {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "SHA256SUMS"), checksums);
      if (signature !== undefined) writeFileSync(join(target, "SHA256SUMS.sig"), signature);
    }
  }

  /** Replaces a published release's SHA256SUMS after it was signed. */
  tamper(version: string, change: (checksums: string) => string): void {
    for (const folder of [join(this.root, "download", `v${version}`), join(this.root, "latest", "download")]) {
      const file = join(folder, "SHA256SUMS");
      writeFileSync(file, change(readFileSync(file, "utf8")));
    }
  }

  /** Bash that, after the script is sourced, serves its downloads from this folder and trusts the test keys. */
  get downloads(): string {
    for (const key of [pinnedKey, otherPinnedKey]) writeFileSync(join(this.keys, `${key.id}.pem`), key.publicKeyPem);
    // The real download is HTTPS only; this one copies from the folder, failing as curl does on a 404,
    // and notes each file's cap in downloads.log. No single quotes: a test runs it inside bash -c '…'.
    return [
      `RELEASES_URL=https://example.test/releases; download() { echo "\${1##*/} $3" >>"${this.downloadsLog}"; cp -- "${this.root}/\${1#"$RELEASES_URL/"}" "$2" 2>/dev/null; }`,
      `trusted_key() { [[ "$1" =~ ^[0-9a-f]{16}$ && -f "${this.keys}/$1.pem" ]] && cat -- "${this.keys}/$1.pem"; }`,
    ].join("; ");
  }
}

function packTarball(name: string): Buffer {
  const staging = temporaryDirectory();
  mkdirSync(join(staging, name));
  // Not executable: the script runs it through bash, as the temporary folder may be on a noexec /tmp.
  writeFileSync(join(staging, name, "install.sh"), fakeInstaller, { mode: 0o644 });
  const archive = join(staging, "archive.tar.gz");
  expect(run("tar", ["--create", "--gzip", "--file", archive, "--directory", staging, name]).status).toBe(0);
  return readFileSync(archive);
}

/** Runs the script's main with the arguments, its downloads served from the fake releases. */
function bootstrap(releases: FakeReleases, args: readonly string[], options: { env?: NodeJS.ProcessEnv } = {}): Run {
  // Sourced, the script doesn't run main by itself.
  return run("bash", ["-c", `set -euo pipefail; source "$0"; ${releases.downloads}; main "$@"`, bootstrapScript, ...args], options);
}

/** Runs the real download with curl replaced by a fake that writes the bytes and exits with the code. */
function fakeCurlDownload(bytes: number, exitCode: number, cap = 4096) {
  const folder = temporaryDirectory();
  const fake = `curl() { echo "curl $*" >"${folder}/args"; head -c ${bytes} /dev/zero >"\${@: -2:1}"; return ${exitCode}; }`;
  const ran = sourced(bootstrapScript, `${fake}; download https://example.test/SHA256SUMS.sig "${folder}/SHA256SUMS.sig" ${cap}`);
  return { ran, args: existsSync(join(folder, "args")) ? readFileSync(join(folder, "args"), "utf8") : "" };
}

describe("the one-line installer (scripts/release/bootstrap-install.sh)", () => {
  let releases: FakeReleases;
  beforeEach(() => {
    releases = new FakeReleases();
  });

  it("installs the latest release for this architecture, passing the installer's options through", () => {
    releases.publish("1.0.0", { latest: false });
    releases.publish("1.1.0");

    const result = bootstrap(releases, ["--public-origin", "https://files.example.com", "--allow-folder", "/srv/a b", "--yes"]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Downloading NotUnreachable 1.1.0 for linux-${arch}`);
    expect(result.stdout).toContain(`not-unreachable-1.1.0-linux-${arch}.tar.gz matches SHA256SUMS`);
    expect(result.stdout).toContain(
      "installer: --public-origin\ninstaller: https://files.example.com\ninstaller: --allow-folder\ninstaller: /srv/a b\ninstaller: --yes\n",
    );
  });

  it("installs the release given with --version, and doesn't pass --version on", () => {
    releases.publish("1.0.0", { latest: false });
    releases.publish("1.1.0");

    const result = bootstrap(releases, ["--version", "v1.0.0", "--yes"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Downloading NotUnreachable 1.0.0 for linux-${arch}`);
    expect(result.stdout).toContain("installer: --yes\n");
    expect(result.stdout).not.toContain("installer: --version");
    // Each download is capped as the update helper caps it (release-verify.mts).
    expect(readFileSync(releases.downloadsLog, "utf8")).toBe(
      `SHA256SUMS 16384\nSHA256SUMS.sig 4096\nnot-unreachable-1.0.0-linux-${arch}.tar.gz 268435456\n`,
    );
  });

  it("matches the update helper's caps", () => {
    const caps = readRepoFile("deploy/mount-helper/src/release-verify.mts");
    const printed = sourced(bootstrapScript, 'echo "$MAX_SIGNATURE_FILE_BYTES $MAX_CHECKSUMS_FILE_BYTES $MAX_TARBALL_BYTES"');
    expect(caps).toContain("MAX_SIGNATURE_FILE_BYTES = 4096;");
    expect(caps).toContain("MAX_CHECKSUMS_FILE_BYTES = 16 * 1024;");
    expect(caps).toContain("MAX_TARBALL_BYTES = 256 * 1024 * 1024;");
    expect(printed.stdout).toBe(`4096 ${16 * 1024} ${256 * 1024 * 1024}\n`);
  });

  it("downloads over HTTPS only, passing the cap to curl", () => {
    const { ran, args } = fakeCurlDownload(4096, 0);
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(args).toContain("--proto =https");
    expect(args).toContain("--max-filesize 4096");
  });

  it("stops on a file curl refuses as over the cap (exit 63)", () => {
    const { ran } = fakeCurlDownload(0, 63);
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("SHA256SUMS.sig is over 4096 bytes: not installing anything.");
  });

  it("stops on a file over the cap that curl downloaded whole, as older curl does without a Content-Length", () => {
    const { ran } = fakeCurlDownload(4097, 0);
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("SHA256SUMS.sig is over 4096 bytes");
  });

  it("returns curl's failure for its caller to name", () => {
    const { ran } = fakeCurlDownload(0, 22);
    expect(ran.status).toBe(22);
    expect(ran.stderr).toBe("");
  });

  it("stops before running anything when the tarball doesn't match SHA256SUMS", () => {
    releases.publish("1.1.0", { checksum: "0".repeat(64) });

    const result = bootstrap(releases, ["--yes"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`not-unreachable-1.1.0-linux-${arch}.tar.gz doesn't match SHA256SUMS`);
    expect(result.stdout).not.toContain("installer:");
  });

  it("stops when the release has no tarball for this architecture", () => {
    releases.publish("1.1.0", { archs: [otherArch] });

    const result = bootstrap(releases, []);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`the latest release has no tarball for linux-${arch}`);
  });

  it("stops when the release doesn't exist", () => {
    releases.publish("1.1.0");

    const result = bootstrap(releases, ["--version", "9.9.9"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not download SHA256SUMS of release 9.9.9");
  });

  it("refuses a version that isn't one", () => {
    const result = bootstrap(releases, ["--version", "1.0.0; rm -rf /"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not a version such as 1.2.3");
  });

  it("removes its temporary folder when it is done", () => {
    releases.publish("1.1.0");
    const temporary = temporaryDirectory();

    const result = bootstrap(releases, [], { env: { TMPDIR: temporary } });

    expect(result.status).toBe(0);
    expect(readdirSync(temporary)).toEqual([]);
  });

  it.skipIf(!installed("setsid"))("gives the installer no stdin when it is piped and there is no terminal", () => {
    releases.publish("1.1.0");
    // setsid leaves the run without a controlling terminal, so /dev/tty can't be opened.
    const result = run(
      "setsid",
      ["--wait", "bash", "-c", `set -euo pipefail; source "$1"; ${releases.downloads}; main`, "test", bootstrapScript],
      {
        input: "the rest of the piped script",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("stdin: /dev/null");
  });

  it.skipIf(!installed("script"))("asks the installer's questions on the terminal when it is piped", () => {
    releases.publish("1.1.0");
    // script(1) gives the run a terminal while bash's stdin stays a pipe, as with `curl … | sudo bash`.
    const command = `echo the rest of the piped script | bash -c 'set -euo pipefail; source "$0"; ${releases.downloads}; main' ${bootstrapScript}`;

    const result = run("script", ["--quiet", "--return", "--command", command, "/dev/null"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("stdin: terminal");
  });

  it("checks the signature of SHA256SUMS before trusting it", () => {
    releases.publish("1.1.0");

    const result = bootstrap(releases, ["--yes"]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SHA256SUMS is signed by a trusted key");
    expect(result.stdout).toContain("installer: --yes");
  });

  it("stops, installing nothing, when SHA256SUMS was changed after it was signed", () => {
    releases.publish("1.1.0");
    // A swapped tarball with its own checksum: only the signature can tell.
    releases.tamper("1.1.0", (checksums) => checksums.replace(/^[0-9a-f]{64}/u, "f".repeat(64)));

    const result = bootstrap(releases, ["--yes"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`the signature of SHA256SUMS by key ${pinnedKey.id} doesn't verify`);
    expect(result.stdout).not.toContain("Downloading");
    expect(result.stdout).not.toContain("installer:");
  });

  it("stops when the release has no SHA256SUMS.sig, as one from before releases were signed", () => {
    releases.publish("1.0.0", { latest: false, signature: null });
    releases.publish("1.1.0");

    const result = bootstrap(releases, ["--version", "1.0.0"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not download SHA256SUMS.sig of release 1.0.0");
    expect(result.stderr).toContain("install it by hand");
    expect(result.stdout).not.toContain("installer:");
  });

  it("stops when no line is by a key it trusts", () => {
    releases.publish("1.1.0", { signature: (checksums) => signatureLine(unpinnedKey, checksums) });

    const result = bootstrap(releases, ["--yes"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SHA256SUMS.sig has no signature by a key this installer trusts");
    expect(result.stdout).not.toContain("installer:");
  });

  it("skips a line by a key it doesn't trust beside one that verifies", () => {
    releases.publish("1.1.0", { signature: (checksums) => signatureLine(unpinnedKey, checksums) + signatureLine(pinnedKey, checksums) });

    const result = bootstrap(releases, ["--yes"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("installer: --yes");
  });

  it("stops when a trusted line fails, even beside one that verifies", () => {
    releases.publish("1.1.0", {
      signature: (checksums) => signatureLine(pinnedKey, checksums) + signatureLine(otherPinnedKey, `${checksums} `),
    });

    const result = bootstrap(releases, ["--yes"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`by key ${otherPinnedKey.id} doesn't verify`);
    expect(result.stdout).not.toContain("installer:");
  });

  it.each([
    ["an empty file", () => ""],
    ["no final newline", (checksums: string) => signatureLine(pinnedKey, checksums).trimEnd()],
    ["another algorithm", (checksums: string) => signatureLine(pinnedKey, checksums).replace("ed25519", "rsa")],
    ["a short signature", (checksums: string) => signatureLine(pinnedKey, checksums).replace("==\n", "\n")],
    ["a Windows line end", (checksums: string) => signatureLine(pinnedKey, checksums).replace("\n", "\r\n")],
    ["the same key twice", (checksums: string) => signatureLine(pinnedKey, checksums).repeat(2)],
    [
      "five lines",
      (checksums: string) =>
        [signingKey(), signingKey(), signingKey(), signingKey(), pinnedKey].map((key) => signatureLine(key, checksums)).join(""),
    ],
    ["a file over 4 KiB", (checksums: string) => signatureLine(pinnedKey, checksums) + "#".repeat(4096)],
  ])("stops on a malformed SHA256SUMS.sig: %s", (_, signature) => {
    releases.publish("1.1.0", { signature });

    const result = bootstrap(releases, ["--yes"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SHA256SUMS.sig is malformed");
    expect(result.stdout).not.toContain("installer:");
  });

  it.each(["OpenSSL 3.0.13 30 Jan 2024 (Library: OpenSSL 3.0.13 30 Jan 2024)", "OpenSSL 3.5.1 1 Jul 2025"])(
    "takes %j as openssl 3.0 or later",
    (version) => {
      expect(sourced(bootstrapScript, `check_openssl "${version}"`).status).toBe(0);
    },
  );

  it.each(["OpenSSL 1.1.1w  11 Sep 2023", "LibreSSL 3.3.6", ""])("refuses %j, which isn't openssl 3.0 or later", (version) => {
    const checked = sourced(bootstrapScript, `check_openssl "${version}"`);
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain("openssl 3.0 or later is needed");
  });

  it("trusts exactly the keys pinned in deploy/keys/release-signing/, inline", () => {
    const folder = "deploy/keys/release-signing";
    const pinned = readdirSync(join(repoRoot, folder)).toSorted();
    const inline = [...readRepoFile("scripts/release/bootstrap-install.sh").matchAll(/^ {4}([0-9a-f]{16})\)$/gmu)].map(
      (match) => `${match[1]}.pem`,
    );
    expect(inline.toSorted()).toEqual(pinned);
    for (const name of pinned) {
      const printed = sourced(bootstrapScript, `trusted_key ${name.replace(".pem", "")}`);
      expect(printed.status, name).toBe(0);
      expect(printed.stdout, name).toBe(readRepoFile(`${folder}/${name}`));
    }
    expect(sourced(bootstrapScript, `trusted_key ${"0".repeat(16)}`).status).toBe(1);
  });

  it.skipIf(!installed("openssl"))("verifies a signature made the way sign-checksums.ts makes it with an inline key's format", () => {
    // The real openssl and base64 against a signature by Node's crypto, as the sign job makes it.
    const folder = temporaryDirectory();
    const checksums = `${"a".repeat(64)}  install.sh\n`;
    writeFileSync(join(folder, "SHA256SUMS"), checksums);
    writeFileSync(join(folder, "SHA256SUMS.sig"), signatureLine(pinnedKey, checksums));
    writeFileSync(join(folder, "pinned.pem"), pinnedKey.publicKeyPem);
    const snippet = `trusted_key() { [[ "$1" == ${pinnedKey.id} ]] && cat "$0/pinned.pem"; }; verify_signature "$0/SHA256SUMS" "$0/SHA256SUMS.sig" "$0"`;
    const verified = run("bash", ["-c", `set -euo pipefail; source "${bootstrapScript}"; ${snippet}`, folder]);
    expect(verified.stderr).toBe("");
    expect(verified.status).toBe(0);
  });

  it("prints its help, naming the installer's options", () => {
    const result = sourced(bootstrapScript, "main --help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--version VERSION");
    expect(result.stdout).toContain("--public-origin");
  });
});
