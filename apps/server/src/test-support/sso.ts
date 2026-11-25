import { routes, type SsoProvider, type SsoRedirect } from "@not-unreachable/contracts";
import type { LightMyRequestResponse } from "fastify";
import { linkedSignIns, SSO_COOKIE, type NewSsoProvider } from "../modules/sso/index.ts";
import { newId } from "../modules/platform/index.ts";
import { buildTestApp, sameOriginWrite, viaProxy, type TestApp, type TestAppOptions } from "./app.ts";
import {
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_ISSUER,
  fakeProvidersFetch,
  fakeTargets,
  startFakeGitHub,
  startFakeOidcProvider,
  type FakeGitHub,
  type FakeOidcProvider,
} from "./fake-sso.ts";

/** A test app whose sso module reaches the fake OIDC provider (at {@link FAKE_ISSUER}) and the fake GitHub. */
export interface SsoTestRig {
  readonly test: TestApp;
  readonly idp: FakeOidcProvider;
  readonly github: FakeGitHub;
  close(): Promise<void>;
}

export async function buildSsoTestApp(options: TestAppOptions = {}): Promise<SsoTestRig> {
  const idp = await startFakeOidcProvider();
  const github = await startFakeGitHub();
  const test = await buildTestApp({ ssoDiscoveryTimeoutMs: 300, ...options, ssoFetch: fakeProvidersFetch(fakeTargets(idp, github)) });
  idp.useClock(test.clock);
  return {
    test,
    idp,
    github,
    close: async () => {
      await test.close();
      await idp.close();
      await github.close();
    },
  };
}

/** The fake OIDC provider's settings, as the admin would add it. */
export function fakeOidcProvider(overrides: Partial<Extract<NewSsoProvider, { kind: "oidc" }>> = {}): NewSsoProvider {
  return {
    kind: "oidc",
    name: "Test IdP",
    issuer: FAKE_ISSUER,
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    enabled: true,
    ...overrides,
  };
}

/** Adds a provider straight through the service, as the system. */
export function addTestProvider(test: Pick<TestApp, "services">, provider: NewSsoProvider = fakeOidcProvider()): Promise<SsoProvider> {
  return test.services.sso.providers.add(provider, { actor: { kind: "system" } });
}

/** Links an identity to an account straight in the database, as an invitation or Settings would; answers the link's id. */
export function linkTestIdentity(
  test: Pick<TestApp, "database" | "clock">,
  accountId: string,
  provider: Pick<SsoProvider, "id" | "issuer">,
  subject: string,
  email: string | null = null,
): string {
  const id = newId(test.clock);
  test.database.db
    .insert(linkedSignIns)
    .values({
      id,
      userId: accountId,
      providerId: provider.id,
      issuer: provider.issuer,
      subject,
      emailAtLink: email,
      createdAt: test.clock.now().toISOString(),
      lastUsedAt: null,
    })
    .run();
  return id;
}

/** The `Cookie` header value for the flow cookie a response sets; throws when it sets none. */
export function ssoFlowCookieFrom(response: LightMyRequestResponse): string {
  const header = response.headers["set-cookie"];
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const match = values.map((value) => new RegExp(`^${SSO_COOKIE}=([A-Za-z0-9_-]{43});`).exec(value)).find((found) => found !== null);
  if (match?.[1] === undefined) throw new Error(`No SSO cookie in the response (status ${response.statusCode}): ${response.body}`);
  return `${SSO_COOKIE}=${match[1]}`;
}

export interface StartedTestFlow {
  /** The provider's authorization URL. */
  readonly url: string;
  /** The `Cookie` header value binding the flow. */
  readonly flowCookie: string;
  readonly response: LightMyRequestResponse;
}

/** Starts an SSO sign-in as the SPA would. */
export async function startSsoSignIn(test: Pick<TestApp, "app">, providerId: string): Promise<StartedTestFlow> {
  const response = await test.app.inject({
    method: "POST",
    url: routes.startSsoSignIn.path.replace(":id", providerId),
    headers: sameOriginWrite,
  });
  if (response.statusCode !== 200) throw new Error(`The SSO start failed with ${response.statusCode}: ${response.body}`);
  return { url: response.json<SsoRedirect>().url, flowCookie: ssoFlowCookieFrom(response), response };
}

/** Starts linking an identity from a signed-in session, as Settings → Linked sign-ins would. */
export async function startTestLink(test: Pick<TestApp, "app">, sessionCookie: string, providerId: string): Promise<StartedTestFlow> {
  const response = await test.app.inject({
    method: "POST",
    url: routes.startLink.path,
    headers: { ...sameOriginWrite, cookie: sessionCookie },
    payload: { providerId },
  });
  if (response.statusCode !== 200) throw new Error(`The link start failed with ${response.statusCode}: ${response.body}`);
  return { url: response.json<SsoRedirect>().url, flowCookie: ssoFlowCookieFrom(response), response };
}

/** Follows the provider's redirect back to the callback, as the browser would (with the flow cookie unless null). */
export function followToCallback(
  test: Pick<TestApp, "app">,
  callback: URL,
  flowCookie: string | null,
  headers: Readonly<Record<string, string>> = {},
): Promise<LightMyRequestResponse> {
  return test.app.inject({
    method: "GET",
    url: `${callback.pathname}${callback.search}`,
    headers: { ...viaProxy, ...(flowCookie === null ? {} : { cookie: flowCookie }), ...headers },
  });
}
