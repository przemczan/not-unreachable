import { problemMediaType, problemTypes, type Problem, type ProblemType } from "@not-unreachable/contracts";
import type { FastifyReply } from "fastify";

const titles: Record<ProblemType, string> = {
  [problemTypes.badRequest]: "Bad request",
  [problemTypes.validationFailed]: "The request is not valid",
  [problemTypes.breachedPassword]: "This password is on a list of breached passwords",
  [problemTypes.httpsRequired]: "HTTPS is required",
  [problemTypes.signInRequired]: "Sign-in required",
  [problemTypes.signInFailed]: "Sign-in failed",
  [problemTypes.recentSignInRequired]: "Recent sign-in required",
  [problemTypes.secondFactorFailed]: "The code is not right",
  [problemTypes.secondFactorExists]: "A second factor is already set up",
  [problemTypes.lastSecondFactor]: "The last second factor can't be removed",
  [problemTypes.tooManyAttempts]: "Too many attempts",
  [problemTypes.forbidden]: "Forbidden",
  [problemTypes.csrfRejected]: "Cross-site request rejected",
  [problemTypes.notFound]: "Not found",
  [problemTypes.methodNotAllowed]: "Method not allowed",
  [problemTypes.payloadTooLarge]: "The request body is too large",
  [problemTypes.unsupportedMediaType]: "Unsupported media type",
  [problemTypes.rateLimited]: "Too many requests",
  [problemTypes.internalError]: "Internal server error",
  [problemTypes.serviceUnavailable]: "Service unavailable",
  [problemTypes.folderRefused]: "This folder can't be used as a resource",
  [problemTypes.folderNotAllowable]: "This folder can't be allowed from the admin interface",
  [problemTypes.shareRefused]: "The share couldn't be mounted",
  [problemTypes.resourceNameTaken]: "Another resource has this name",
  [problemTypes.resourceUnavailable]: "The resource is unavailable",
  [problemTypes.homeRootResource]: "The home root's resource can't be removed",
  [problemTypes.pathRefused]: "This path is not allowed",
  [problemTypes.identityAlreadyLinked]: "This sign-in is linked to another account",
  [problemTypes.lastSignInMethod]: "The last way to sign in can't be removed",
  [problemTypes.ssoIssuerTaken]: "Another provider has this issuer",
  [problemTypes.ssoDiscoveryFailed]: "The provider's settings couldn't be found for this issuer",
  [problemTypes.ssoProviderUnreachable]: "The provider could not be reached",
  [problemTypes.ssoProviderInUse]: "This provider has linked sign-ins",
  [problemTypes.ssoProviderIdTaken]: "Another provider has this id",
  [problemTypes.invitationInvalid]: "This link is not valid",
  [problemTypes.usernameTaken]: "This username is taken",
  [problemTypes.usernameReserved]: "This username can't be used",
  [problemTypes.homeRootNotSet]: "The home root is not set",
  [problemTypes.smtpNotConfigured]: "Email is not set up",
  [problemTypes.mailSendFailed]: "The email could not be sent",
  [problemTypes.nameTaken]: "This name is already taken in the folder",
  [problemTypes.folderNotEmpty]: "The folder is not empty",
  [problemTypes.rangeNotSatisfiable]: "The range is outside the file",
  [problemTypes.quotaExceeded]: "The upload doesn't fit in the quota",
  [problemTypes.fileTooLarge]: "The file is larger than the size limit",
  [problemTypes.uploadLengthRequired]: "The upload's length is required",
  [problemTypes.insufficientStorage]: "There isn't enough free disk space",
  [problemTypes.tooManyUploads]: "Too many uploads",
  [problemTypes.shareLinkInvalid]: "This link is not valid",
  [problemTypes.shareLinkPasswordRequired]: "This link needs its password",
  [problemTypes.shareLinkPasswordWrong]: "The password is not right",
  [problemTypes.shareLinkRevoked]: "This link is revoked",
  [problemTypes.shareLinkSignInRequired]: "Sign in to open this link",
  [problemTypes.shareLinkNotAllowed]: "This link is not shared with you",
  [problemTypes.tooManyDownloads]: "Too many downloads at once",
  [problemTypes.updateNotAvailable]: "This release can't be installed from Settings",
  [problemTypes.updateInProgress]: "An update is in progress",
};

/** The problem+json extension members (RFC 9457) a problem may carry. */
export type ProblemExtensions = Pick<Problem, "reason" | "command" | "allowFromUi">;

/** An error that becomes exactly this problem+json response; throw it from hooks and handlers. */
export class HttpProblem extends Error {
  override readonly name = "HttpProblem";
  readonly status: number;
  readonly type: ProblemType;
  readonly detail: string | undefined;
  /** Headers the answer carries, such as `Retry-After`. */
  readonly headers: Readonly<Record<string, string>>;
  readonly extensions: ProblemExtensions;

  constructor(
    status: number,
    type: ProblemType,
    detail?: string,
    headers: Readonly<Record<string, string>> = {},
    extensions: ProblemExtensions = {},
    /** The `cause`, such as the failure behind a 502: the log has it, the answer never does. */
    options: ErrorOptions = {},
  ) {
    super(detail ?? titles[type], options);
    this.status = status;
    this.type = type;
    this.detail = detail;
    this.headers = headers;
    this.extensions = extensions;
  }

  toProblem(): Problem {
    return { ...problem(this.status, this.type, this.detail), ...this.extensions };
  }
}

export function problem(status: number, type: ProblemType, detail?: string): Problem {
  return { type, title: titles[type], status, ...(detail === undefined ? {} : { detail }) };
}

/** Sends a problem as a pre-serialised string, so no route's response schema applies to it. */
export function sendProblem(reply: FastifyReply, body: Problem): FastifyReply {
  return reply.code(body.status).type(problemMediaType).send(JSON.stringify(body));
}
