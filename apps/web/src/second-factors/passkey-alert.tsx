import { Alert } from "@not-unreachable/design-system";
import { passkeyFailureOf, passkeysUnsupportedMessage } from "./passkey-ceremony.ts";

/** The Alert for a passkey ceremony that ended without one; nothing for any other error. */
export function PasskeyFailureAlert({ error }: { readonly error: unknown }) {
  const failure = passkeyFailureOf(error);
  return failure === null ? null : <Alert tone={failure.tone}>{failure.text}</Alert>;
}

/** Said where passkey actions would be, in a browser that can't use them. */
export function PasskeysUnsupportedAlert() {
  return <Alert tone="info">{passkeysUnsupportedMessage}</Alert>;
}
