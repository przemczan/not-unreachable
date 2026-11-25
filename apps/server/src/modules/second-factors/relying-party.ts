import {
  authenticatorTransports,
  type AuthenticatorTransport,
  type PasskeyAuthenticationResponse,
  type PasskeyCreationOptions,
  type PasskeyRegistrationResponse,
  type PasskeyRequestOptions,
} from "@not-unreachable/contracts";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

/** The name authenticators show for this site. */
export const RELYING_PARTY_NAME = "NotUnreachable";

/** How long the browser may take over a ceremony; the challenge itself is void after 5 minutes. */
const CEREMONY_TIMEOUT_MS = 5 * 60 * 1000;

export type UserVerification = "required" | "preferred";

export interface CredentialDescriptor {
  readonly credentialId: string;
  readonly transports: readonly string[];
}

export interface RegistrationRequest {
  /** The user handle: the account's id, so a passwordless assertion names its account. */
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  /** The account's passkeys, so an authenticator doesn't register twice. */
  readonly exclude: readonly CredentialDescriptor[];
}

export interface VerifiedRegistration {
  readonly credentialId: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly transports: AuthenticatorTransport[];
  readonly backedUp: boolean;
}

export interface StoredCredential extends CredentialDescriptor {
  readonly publicKey: Uint8Array;
}

export interface VerifiedAssertion {
  readonly counter: number;
  readonly backedUp: boolean;
}

/**
 * The WebAuthn relying party (stack.md, "Passkeys: @simplewebauthn 13"; threat model, T10): the RP ID
 * is the host of `PUBLIC_ORIGIN`, the origin must be `PUBLIC_ORIGIN` exactly, and attestation is
 * `none`. Verification answers undefined for any response that doesn't pass, whatever the reason.
 */
export interface RelyingParty {
  registrationOptions(request: RegistrationRequest): Promise<PasskeyCreationOptions>;
  verifyRegistration(response: PasskeyRegistrationResponse, challenge: string): Promise<VerifiedRegistration | undefined>;
  /** With `allow` empty, any discoverable passkey of this site may answer (passwordless). */
  authenticationOptions(allow: readonly CredentialDescriptor[], userVerification: UserVerification): Promise<PasskeyRequestOptions>;
  /**
   * Checks the signature, challenge, origin, RP ID and user verification. The signature counter is
   * the caller's to compare, so a counter that goes back can be told from a bad signature.
   */
  verifyAssertion(
    response: PasskeyAuthenticationResponse,
    challenge: string,
    credential: StoredCredential,
    userVerification: UserVerification,
  ): Promise<VerifiedAssertion | undefined>;
}

const transportsOf = (transports: readonly string[]): AuthenticatorTransport[] =>
  transports.filter((transport): transport is AuthenticatorTransport => authenticatorTransports.some((known) => known === transport));

const descriptors = (credentials: readonly CredentialDescriptor[]) =>
  credentials.map((credential) => ({ id: credential.credentialId, transports: transportsOf(credential.transports) }));

export function createRelyingParty(publicOrigin: string): RelyingParty {
  const origin = new URL(publicOrigin).origin;
  const rpID = new URL(publicOrigin).hostname;

  return {
    async registrationOptions({ accountId, username, displayName, exclude }) {
      return generateRegistrationOptions({
        rpName: RELYING_PARTY_NAME,
        rpID,
        userName: username,
        userID: new TextEncoder().encode(accountId),
        userDisplayName: displayName,
        timeout: CEREMONY_TIMEOUT_MS,
        attestationType: "none",
        excludeCredentials: descriptors(exclude),
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      });
    },

    async verifyRegistration(response, challenge) {
      try {
        const verified = await verifyRegistrationResponse({
          response,
          expectedChallenge: challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: true,
        });
        if (!verified.verified) return undefined;
        const { credential, credentialBackedUp } = verified.registrationInfo;
        return {
          credentialId: credential.id,
          publicKey: credential.publicKey,
          counter: credential.counter,
          transports: transportsOf(response.response.transports ?? credential.transports ?? []),
          backedUp: credentialBackedUp,
        };
      } catch {
        return undefined;
      }
    },

    async authenticationOptions(allow, userVerification) {
      // The library answers `extensions: undefined` when none are asked for; the contract's options
      // have no such key, so only what it sets is passed on.
      const { challenge, rpId, allowCredentials, timeout } = await generateAuthenticationOptions({
        rpID,
        allowCredentials: descriptors(allow),
        timeout: CEREMONY_TIMEOUT_MS,
        userVerification,
      });
      return {
        challenge,
        ...(rpId === undefined ? {} : { rpId }),
        allowCredentials: (allowCredentials ?? []).map(({ id, type, transports }) => ({
          id,
          type,
          ...(transports === undefined ? {} : { transports: transportsOf(transports) }),
        })),
        ...(timeout === undefined ? {} : { timeout }),
        userVerification,
      };
    },

    async verifyAssertion(response, challenge, credential, userVerification) {
      try {
        const verified = await verifyAuthenticationResponse({
          response,
          expectedChallenge: challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          // 0, so the library never refuses on the counter: the caller compares it after the signature passes.
          credential: { id: credential.credentialId, publicKey: new Uint8Array(credential.publicKey), counter: 0 },
          requireUserVerification: userVerification === "required",
        });
        if (!verified.verified) return undefined;
        return { counter: verified.authenticationInfo.newCounter, backedUp: verified.authenticationInfo.credentialBackedUp };
      } catch {
        return undefined;
      }
    },
  };
}
