import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import {
  routes,
  type AddedPasskey,
  type PasskeyAuthenticationResponse,
  type PasskeyCreationOptions,
  type PasskeyRegistrationResponse,
  type PasskeyRequestOptions,
  type RecoveryCodes,
} from "@not-unreachable/contracts";
import type { LightMyRequestResponse } from "fastify";
import { testOrigin, type TestApp } from "./app.ts";
import { callRoute } from "./sessions.ts";

/*
 * A software WebAuthn authenticator (ES256, `none` attestation) built on node:crypto alone, whose
 * answers are the JSON @simplewebauthn/browser hands the server.
 */

type CborValue = number | string | Uint8Array | ReadonlyMap<CborValue, CborValue> | { readonly [key: string]: CborValue };

function cborHead(major: number, length: number): Buffer {
  const type = major << 5;
  if (length < 24) return Buffer.from([type | length]);
  if (length < 0x100) return Buffer.from([type | 24, length]);
  if (length < 0x10000) {
    const head = Buffer.alloc(3);
    head[0] = type | 25;
    head.writeUInt16BE(length, 1);
    return head;
  }
  const head = Buffer.alloc(5);
  head[0] = type | 26;
  head.writeUInt32BE(length, 1);
  return head;
}

/** A minimal CBOR encoder: integers, byte and text strings, and maps (int or text keys), each in its shortest form. */
export function encodeCbor(value: CborValue): Buffer {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("Only integers");
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([cborHead(2, value.length), value]);
  const entries: [CborValue, CborValue][] = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return Buffer.concat([cborHead(5, entries.length), ...entries.flatMap(([key, item]) => [encodeCbor(key), encodeCbor(item)])]);
}

const sha256 = (data: Uint8Array | string): Buffer => createHash("sha256").update(data).digest();
const base64Url = (data: Uint8Array): string => Buffer.from(data).toString("base64url");

/** Authenticator data flags. */
export const authenticatorFlags = { up: 0x01, uv: 0x04, be: 0x08, bs: 0x10, at: 0x40 } as const;

export interface CeremonyOverrides {
  /** {@link testOrigin} when left out. */
  readonly origin?: string;
  /** The host of {@link testOrigin} when left out. */
  readonly rpId?: string;
  /** Whether the user was verified; the authenticator's setting when left out. */
  readonly userVerified?: boolean;
  /** The authenticator data flags as given, instead of those the other settings make. */
  readonly flags?: number;
  /** The signature counter; for an assertion, the stored one plus 1 when left out. */
  readonly counter?: number;
  /** The challenge the client data names, instead of the options'. */
  readonly challenge?: string;
  /** An assertion's user handle instead of the one registered (null for none). */
  readonly userHandle?: string | null;
  /** The credential id the response names, instead of the authenticator's. */
  readonly credentialId?: string;
}

export interface SoftwarePasskeyOptions {
  /** Whether it verifies the user (UV); true when left out. */
  readonly userVerified?: boolean;
  /** Whether it is backed up (BE and BS); false when left out. */
  readonly backedUp?: boolean;
  /** The counter at registration; 0 when left out. Assertions count up from it. */
  readonly counter?: number;
}

export interface SoftwarePasskey {
  /** base64url. */
  readonly credentialId: string;
  /** The user handle of the last registration, base64url; undefined before one. */
  readonly userHandle: string | undefined;
  /** The counter of the last ceremony. */
  readonly counter: number;
  /** A registration response to `options` (a `navigator.credentials.create`). */
  register(options: PasskeyCreationOptions, overrides?: CeremonyOverrides): PasskeyRegistrationResponse;
  /** An assertion over `options`' challenge (a `navigator.credentials.get`). */
  assert(options: PasskeyRequestOptions, overrides?: CeremonyOverrides): PasskeyAuthenticationResponse;
}

const defaultRpId = new URL(testOrigin).hostname;

const coseKey = (key: KeyObject): Buffer => {
  const jwk = key.export({ format: "jwk" });
  if (jwk.x === undefined || jwk.y === undefined) throw new Error("Not an EC key");
  return encodeCbor(
    new Map<CborValue, CborValue>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x, "base64url")],
      [-3, Buffer.from(jwk.y, "base64url")],
    ]),
  );
};

const counterBytes = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};

const clientData = (type: string, challenge: string, overrides: CeremonyOverrides): Buffer =>
  Buffer.from(
    JSON.stringify({ type, challenge: overrides.challenge ?? challenge, origin: overrides.origin ?? testOrigin, crossOrigin: false }),
  );

export function createSoftwarePasskey(settings: SoftwarePasskeyOptions = {}): SoftwarePasskey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentialId = randomBytes(32);
  let userHandle: string | undefined;
  let counter = settings.counter ?? 0;

  const flagsFor = (overrides: CeremonyOverrides, extra: number): number => {
    if (overrides.flags !== undefined) return overrides.flags;
    const verified = overrides.userVerified ?? settings.userVerified ?? true;
    const backup = settings.backedUp === true ? authenticatorFlags.be | authenticatorFlags.bs : 0;
    return authenticatorFlags.up | (verified ? authenticatorFlags.uv : 0) | backup | extra;
  };

  return {
    credentialId: base64Url(credentialId),
    get userHandle() {
      return userHandle;
    },
    get counter() {
      return counter;
    },

    register(options, overrides = {}) {
      userHandle = options.user.id;
      if (overrides.counter !== undefined) counter = overrides.counter;
      const length = Buffer.alloc(2);
      length.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        sha256(overrides.rpId ?? defaultRpId),
        Buffer.from([flagsFor(overrides, authenticatorFlags.at)]),
        counterBytes(counter),
        Buffer.alloc(16),
        length,
        credentialId,
        coseKey(publicKey),
      ]);
      const attestationObject = encodeCbor({ fmt: "none", attStmt: {}, authData });
      const id = overrides.credentialId ?? base64Url(credentialId);
      return {
        id,
        rawId: id,
        response: {
          clientDataJSON: base64Url(clientData("webauthn.create", options.challenge, overrides)),
          attestationObject: base64Url(attestationObject),
          transports: ["internal", "hybrid"],
          publicKeyAlgorithm: -7,
        },
        type: "public-key",
        clientExtensionResults: { credProps: { rk: true } },
        authenticatorAttachment: "platform",
      };
    },

    assert(options, overrides = {}) {
      counter = overrides.counter ?? counter + 1;
      const authData = Buffer.concat([sha256(overrides.rpId ?? defaultRpId), Buffer.from([flagsFor(overrides, 0)]), counterBytes(counter)]);
      const clientDataJSON = clientData("webauthn.get", options.challenge, overrides);
      const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), privateKey);
      const handle = overrides.userHandle === undefined ? userHandle : overrides.userHandle;
      const id = overrides.credentialId ?? base64Url(credentialId);
      return {
        id,
        rawId: id,
        response: {
          clientDataJSON: base64Url(clientDataJSON),
          authenticatorData: base64Url(authData),
          signature: base64Url(signature),
          ...(handle === undefined || handle === null ? {} : { userHandle: handle }),
        },
        type: "public-key",
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
  };
}

type Injectable = Pick<TestApp, "app">;

function ok(response: LightMyRequestResponse, what: string): LightMyRequestResponse {
  if (response.statusCode !== 200) throw new Error(`${what} failed with ${response.statusCode}: ${response.body}`);
  return response;
}

/** Adds `passkey` in Settings → Two-step sign-in of an active session with a recent sign-in. */
export async function addPasskeyInSettings(
  test: Injectable,
  cookie: string,
  passkey: SoftwarePasskey,
  name = "Phone",
): Promise<AddedPasskey> {
  const options = ok(
    await callRoute(test, routes.startPasskeyRegistration, { cookie }),
    "registration-options",
  ).json<PasskeyCreationOptions>();
  const added = await callRoute(test, routes.addPasskey, { cookie, payload: { name, response: passkey.register(options) } });
  return ok(added, "add passkey").json<AddedPasskey>();
}

/** Enrols `passkey` at the sign-in step of a pending session, without acknowledging the recovery codes. */
export async function enrolPasskeyAtSignIn(
  test: Injectable,
  pendingCookie: string,
  passkey: SoftwarePasskey,
  name = "Phone",
): Promise<string[]> {
  const options = ok(
    await callRoute(test, routes.startPasskeyEnrolment, { cookie: pendingCookie }),
    "enrol options",
  ).json<PasskeyCreationOptions>();
  const confirmed = await callRoute(test, routes.confirmPasskeyEnrolment, {
    cookie: pendingCookie,
    payload: { name, response: passkey.register(options) },
  });
  return ok(confirmed, "enrol passkey").json<RecoveryCodes>().recoveryCodes;
}
