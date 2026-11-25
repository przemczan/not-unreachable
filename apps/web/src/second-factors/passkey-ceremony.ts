import {
  passkeyAuthenticationResponseSchema,
  passkeyRegistrationResponseSchema,
  type PasskeyAuthenticationResponse,
  type PasskeyCreationOptions,
  type PasskeyRegistrationResponse,
  type PasskeyRequestOptions,
} from "@not-unreachable/contracts";
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";

/**
 * The browser's side of a passkey ceremony (@simplewebauthn/browser), with its failures mapped to
 * what a screen says about them.
 */

/** The admin's passkeys (Settings → Two-step sign-in, and the recent sign-in's choices). */
export const passkeysQueryKey = ["settings", "passkeys"] as const;

/** Why a ceremony ended without a passkey. */
export type PasskeyFailureReason =
  /** The person closed the browser's prompt, or it timed out: nothing went wrong. */
  | "cancelled"
  /** The browser can't use passkeys at all. */
  | "unsupported"
  /** Registration only: the authenticator already holds a passkey of this account. */
  | "already-added"
  /** Anything else: the browser or the authenticator refused. */
  | "failed";

export class PasskeyCeremonyError extends Error {
  readonly reason: PasskeyFailureReason;

  constructor(reason: PasskeyFailureReason, options?: ErrorOptions) {
    super(`The passkey ceremony ended: ${reason}.`, options);
    this.name = "PasskeyCeremonyError";
    this.reason = reason;
  }
}

export function isPasskeyCeremonyError(error: unknown): error is PasskeyCeremonyError {
  return error instanceof PasskeyCeremonyError;
}

/** Whether this browser can use passkeys at all. */
export function passkeysSupported(): boolean {
  return browserSupportsWebAuthn();
}

export const passkeysUnsupportedMessage = "This browser can't use passkeys. Use another way, or another browser.";

const passkeyMessages: Record<PasskeyFailureReason, string> = {
  cancelled: "The passkey request was cancelled or timed out. Try again when you're ready.",
  unsupported: passkeysUnsupportedMessage,
  "already-added": "This passkey is already added to your account. Use another one.",
  failed: "The passkey didn't work. Try again, or use another one.",
};

/** What a screen says about a failed ceremony, and how loudly: a cancelled one is calm. */
export function passkeyFailureOf(error: unknown): { readonly tone: "info" | "danger"; readonly text: string } | null {
  if (!isPasskeyCeremonyError(error)) return null;
  const tone = error.reason === "cancelled" || error.reason === "unsupported" ? "info" : "danger";
  return { tone, text: passkeyMessages[error.reason] };
}

function nameOf(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  // @simplewebauthn wraps the browser's DOMException; its cause keeps the original name.
  if (error.cause instanceof Error && error.name === "Error") return error.cause.name;
  return error.name;
}

function codeOf(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null;
}

function ceremonyErrorOf(error: unknown): PasskeyCeremonyError {
  if (isPasskeyCeremonyError(error)) return error;
  const code = codeOf(error);
  const name = nameOf(error);
  if (code === "ERROR_CEREMONY_ABORTED" || name === "NotAllowedError" || name === "AbortError")
    return new PasskeyCeremonyError("cancelled", { cause: error });
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || name === "InvalidStateError")
    return new PasskeyCeremonyError("already-added", { cause: error });
  if (name === "NotSupportedError") return new PasskeyCeremonyError("unsupported", { cause: error });
  return new PasskeyCeremonyError("failed", { cause: error });
}

/** Makes a new passkey for the server's creation options; rejects with a PasskeyCeremonyError. */
export async function createPasskey(optionsJSON: PasskeyCreationOptions): Promise<PasskeyRegistrationResponse> {
  if (!passkeysSupported()) throw new PasskeyCeremonyError("unsupported");
  let response: unknown;
  try {
    response = await startRegistration({ optionsJSON });
  } catch (error) {
    throw ceremonyErrorOf(error);
  }
  const parsed = passkeyRegistrationResponseSchema.safeParse(response);
  if (!parsed.success) throw new PasskeyCeremonyError("failed", { cause: parsed.error });
  return parsed.data;
}

/** Signs the server's challenge with one of the account's passkeys; rejects with a PasskeyCeremonyError. */
export async function signWithPasskey(optionsJSON: PasskeyRequestOptions): Promise<PasskeyAuthenticationResponse> {
  if (!passkeysSupported()) throw new PasskeyCeremonyError("unsupported");
  let response: unknown;
  try {
    response = await startAuthentication({ optionsJSON });
  } catch (error) {
    throw ceremonyErrorOf(error);
  }
  const parsed = passkeyAuthenticationResponseSchema.safeParse(response);
  if (!parsed.success) throw new PasskeyCeremonyError("failed", { cause: parsed.error });
  return parsed.data;
}
