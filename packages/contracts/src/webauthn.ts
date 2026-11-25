import { z } from "zod";

/*
 * The WebAuthn JSON the server's @simplewebauthn/server answers and the browser's
 * @simplewebauthn/browser sends back (stack.md, "Passkeys: @simplewebauthn 13"). Byte fields are
 * base64url strings; extension outputs pass through as JSON.
 */

const base64Url = z.string().regex(/^[A-Za-z0-9_-]*$/);

export const authenticatorTransports = ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"] as const;
export type AuthenticatorTransport = (typeof authenticatorTransports)[number];

const credentialDescriptorSchema = z.strictObject({
  id: base64Url,
  type: z.literal("public-key"),
  transports: z.array(z.enum(authenticatorTransports)).exactOptional(),
});

const userVerification = z.enum(["required", "preferred", "discouraged"]);
const hints = z.array(z.enum(["hybrid", "security-key", "client-device"])).exactOptional();
/** The only extension the server asks for: `credProps`, so registration learns whether the passkey is discoverable. */
const extensions = z.strictObject({ credProps: z.boolean().exactOptional() }).exactOptional();

/** `PublicKeyCredentialCreationOptionsJSON`: what the browser needs to make a passkey. */
export const passkeyCreationOptionsSchema = z.strictObject({
  rp: z.strictObject({ id: z.string().exactOptional(), name: z.string() }),
  user: z.strictObject({ id: base64Url, name: z.string(), displayName: z.string() }),
  challenge: base64Url,
  pubKeyCredParams: z.array(z.strictObject({ alg: z.int(), type: z.literal("public-key") })),
  timeout: z.int().exactOptional(),
  excludeCredentials: z.array(credentialDescriptorSchema).exactOptional(),
  authenticatorSelection: z
    .strictObject({
      authenticatorAttachment: z.enum(["platform", "cross-platform"]).exactOptional(),
      requireResidentKey: z.boolean().exactOptional(),
      residentKey: z.enum(["discouraged", "preferred", "required"]).exactOptional(),
      userVerification: userVerification.exactOptional(),
    })
    .exactOptional(),
  hints,
  attestation: z.enum(["direct", "enterprise", "indirect", "none"]).exactOptional(),
  extensions,
});

export type PasskeyCreationOptions = z.infer<typeof passkeyCreationOptionsSchema>;

/** `PublicKeyCredentialRequestOptionsJSON`: what the browser needs to sign in with a passkey. */
export const passkeyRequestOptionsSchema = z.strictObject({
  challenge: base64Url,
  timeout: z.int().exactOptional(),
  rpId: z.string().exactOptional(),
  allowCredentials: z.array(credentialDescriptorSchema).exactOptional(),
  userVerification: userVerification.exactOptional(),
  hints,
  extensions,
});

export type PasskeyRequestOptions = z.infer<typeof passkeyRequestOptionsSchema>;

const credentialFields = {
  id: base64Url.min(1).max(1400),
  rawId: base64Url.min(1).max(1400),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).exactOptional(),
  clientExtensionResults: z.record(z.string(), z.json()),
  type: z.literal("public-key"),
};

/** `RegistrationResponseJSON`: a new passkey's attestation. */
export const passkeyRegistrationResponseSchema = z.strictObject({
  ...credentialFields,
  response: z.strictObject({
    clientDataJSON: base64Url.min(1),
    attestationObject: base64Url.min(1),
    authenticatorData: base64Url.exactOptional(),
    transports: z.array(z.enum(authenticatorTransports)).exactOptional(),
    publicKeyAlgorithm: z.int().exactOptional(),
    publicKey: base64Url.exactOptional(),
  }),
});

export type PasskeyRegistrationResponse = z.infer<typeof passkeyRegistrationResponseSchema>;

/** `AuthenticationResponseJSON`: a passkey's signed assertion. */
export const passkeyAuthenticationResponseSchema = z.strictObject({
  ...credentialFields,
  response: z.strictObject({
    clientDataJSON: base64Url.min(1),
    authenticatorData: base64Url.min(1),
    signature: base64Url.min(1),
    userHandle: base64Url.exactOptional(),
  }),
});

export type PasskeyAuthenticationResponse = z.infer<typeof passkeyAuthenticationResponseSchema>;
