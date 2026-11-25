import { z } from "zod";

/** Stable problem types (RFC 9457 `type`), which the UI maps to its own wording. */
export const problemTypes = {
  badRequest: "/problems/bad-request",
  validationFailed: "/problems/validation-failed",
  breachedPassword: "/problems/breached-password",
  httpsRequired: "/problems/https-required",
  signInRequired: "/problems/sign-in-required",
  signInFailed: "/problems/sign-in-failed",
  recentSignInRequired: "/problems/recent-sign-in-required",
  secondFactorFailed: "/problems/second-factor-failed",
  secondFactorExists: "/problems/second-factor-exists",
  lastSecondFactor: "/problems/last-second-factor",
  tooManyAttempts: "/problems/too-many-attempts",
  forbidden: "/problems/forbidden",
  csrfRejected: "/problems/csrf-rejected",
  notFound: "/problems/not-found",
  methodNotAllowed: "/problems/method-not-allowed",
  payloadTooLarge: "/problems/payload-too-large",
  unsupportedMediaType: "/problems/unsupported-media-type",
  rateLimited: "/problems/rate-limited",
  internalError: "/problems/internal-error",
  serviceUnavailable: "/problems/service-unavailable",
  folderRefused: "/problems/folder-refused",
  folderNotAllowable: "/problems/folder-not-allowable",
  shareRefused: "/problems/share-refused",
  resourceNameTaken: "/problems/resource-name-taken",
  resourceUnavailable: "/problems/resource-unavailable",
  homeRootResource: "/problems/home-root-resource",
  pathRefused: "/problems/path-refused",
  identityAlreadyLinked: "/problems/identity-already-linked",
  lastSignInMethod: "/problems/last-sign-in-method",
  ssoIssuerTaken: "/problems/sso-issuer-taken",
  ssoDiscoveryFailed: "/problems/sso-discovery-failed",
  ssoProviderUnreachable: "/problems/sso-provider-unreachable",
  ssoProviderInUse: "/problems/sso-provider-in-use",
  ssoProviderIdTaken: "/problems/sso-provider-id-taken",
  invitationInvalid: "/problems/invitation-invalid",
  usernameTaken: "/problems/username-taken",
  usernameReserved: "/problems/username-reserved",
  homeRootNotSet: "/problems/home-root-not-set",
  smtpNotConfigured: "/problems/smtp-not-configured",
  mailSendFailed: "/problems/mail-send-failed",
  nameTaken: "/problems/name-taken",
  folderNotEmpty: "/problems/folder-not-empty",
  rangeNotSatisfiable: "/problems/range-not-satisfiable",
  quotaExceeded: "/problems/quota-exceeded",
  fileTooLarge: "/problems/file-too-large",
  uploadLengthRequired: "/problems/upload-length-required",
  insufficientStorage: "/problems/insufficient-storage",
  tooManyUploads: "/problems/too-many-uploads",
  shareLinkInvalid: "/problems/share-link-invalid",
  shareLinkPasswordRequired: "/problems/share-link-password-required",
  shareLinkPasswordWrong: "/problems/share-link-password-wrong",
  shareLinkRevoked: "/problems/share-link-revoked",
  shareLinkSignInRequired: "/problems/share-link-sign-in-required",
  shareLinkNotAllowed: "/problems/share-link-not-allowed",
  tooManyDownloads: "/problems/too-many-downloads",
  updateNotAvailable: "/problems/update-not-available",
  updateInProgress: "/problems/update-in-progress",
} as const;

export type ProblemType = (typeof problemTypes)[keyof typeof problemTypes];

export const problemMediaType = "application/problem+json";

/** An `application/problem+json` body. It never holds a stack trace or a file-system path. */
export const problemSchema = z.strictObject({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  /** Extension: the machine-readable reason, such as a `folderRefusals` entry for `folder-refused` or a `shareFailures` entry for `share-refused`. */
  reason: z.string().optional(),
  /** Extension: a command for the admin to run on the host that fixes the problem. */
  command: z.string().optional(),
  /** Extension, on `folder-refused` for `not-writable`: the admin can allow the folder from the admin interface. */
  allowFromUi: z.boolean().optional(),
});

export type Problem = z.infer<typeof problemSchema>;
