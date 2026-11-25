import { routes, type InvitationExpiryDays, type SsoRedirect } from "@not-unreachable/contracts";
import type { LightMyRequestResponse } from "fastify";
import type { AdminContext } from "../modules/invitations/index.ts";
import { sameOriginWrite, type TestApp } from "./app.ts";
import { ssoFlowCookieFrom, type StartedTestFlow } from "./sso.ts";

/** The system acting outside any request, for setting tests up through the services. */
export const systemContext: AdminContext = { actor: { kind: "system" }, origin: { ip: null, userAgent: null } };

/** Adds `dir` as a local-folder resource and makes its top folder the home root. */
export async function setTestHomeRoot(test: Pick<TestApp, "services">, dir: string): Promise<void> {
  const resource = await test.services.resources.add({ kind: "local", name: "Homes", localPath: dir }, { kind: "system" });
  await test.services.resources.setHomeRoot({ resourceId: resource.id, subpath: "" }, { kind: "system" });
}

/** The token at the end of an invitation or re-link link. */
export function tokenOfLink(link: string): string {
  return decodeURIComponent(new URL(link).pathname.split("/").at(-1) ?? "");
}

export interface TestInvitation {
  readonly id: string;
  readonly token: string;
  readonly link: string;
}

/** An invitation made straight through the service, as the system. */
export async function createTestInvitation(
  test: Pick<TestApp, "services">,
  options: {
    readonly email?: string;
    readonly expiresInDays?: InvitationExpiryDays;
    readonly sendByEmail?: boolean;
    readonly verifyEmail?: boolean;
  } = {},
): Promise<TestInvitation> {
  const sendByEmail = options.sendByEmail ?? false;
  const created = await test.services.invitations.create(
    {
      ...(options.email === undefined ? {} : { email: options.email }),
      expiresInDays: options.expiresInDays ?? 7,
      sendByEmail,
      verifyEmail: options.verifyEmail ?? sendByEmail,
    },
    systemContext,
  );
  return { id: created.invitation.id, token: tokenOfLink(created.link), link: created.link };
}

/** A re-link link for the user, made straight through the service; answers its token. */
export async function createTestRelink(test: Pick<TestApp, "services">, userId: string): Promise<string> {
  return tokenOfLink((await test.services.users.createRelinkLink(userId, systemContext)).link);
}

export interface AcceptBody {
  readonly providerId: string;
  readonly username: string;
  readonly displayName?: string;
}

/** POSTs the invitation page's Continue, as the SPA would; any answer. */
export function postAccept(test: Pick<TestApp, "app">, token: string, body: AcceptBody): Promise<LightMyRequestResponse> {
  return test.app.inject({
    method: "POST",
    url: routes.acceptInvitation.path.replace(":token", encodeURIComponent(token)),
    headers: sameOriginWrite,
    payload: { displayName: "A New User", ...body },
  });
}

/** POSTs the re-link page's Continue, as the SPA would; any answer. */
export function postRelinkStart(test: Pick<TestApp, "app">, token: string, providerId: string): Promise<LightMyRequestResponse> {
  return test.app.inject({
    method: "POST",
    url: routes.startRelink.path.replace(":token", encodeURIComponent(token)),
    headers: sameOriginWrite,
    payload: { providerId },
  });
}

const started = (response: LightMyRequestResponse): StartedTestFlow => {
  if (response.statusCode !== 200) throw new Error(`The flow start failed with ${response.statusCode}: ${response.body}`);
  return { url: response.json<SsoRedirect>().url, flowCookie: ssoFlowCookieFrom(response), response };
};

/** Starts accepting an invitation; throws unless it starts. */
export async function startTestAccept(test: Pick<TestApp, "app">, token: string, body: AcceptBody): Promise<StartedTestFlow> {
  return started(await postAccept(test, token, body));
}

/** Starts using a re-link link; throws unless it starts. */
export async function startTestRelink(test: Pick<TestApp, "app">, token: string, providerId: string): Promise<StartedTestFlow> {
  return started(await postRelinkStart(test, token, providerId));
}
