import { problemMediaType, problemTypes, type Dashboard, type Session } from "@not-unreachable/contracts";
import { vi } from "vitest";

export interface MockRequest {
  readonly method: string;
  readonly url: URL;
  readonly body: unknown;
}

/** Answers one request; called afresh for every request, as a Response body is read only once. */
export type MockHandler = (request: MockRequest) => Response | Promise<Response>;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/** A problem answer; `extensions` adds fields such as `reason`, `command` and `allowFromUi`. */
export function problem(
  status: number,
  type: string,
  title = "Problem",
  detail?: string,
  extensions: Readonly<Record<string, string | boolean>> = {},
): Response {
  return new Response(JSON.stringify({ type, title, status, ...(detail === undefined ? {} : { detail }), ...extensions }), {
    status,
    headers: { "Content-Type": problemMediaType },
  });
}

export const adminSession: Session = {
  account: {
    id: "0b6f6c62-7a39-4e4b-9a55-1b2a1f4c3d01",
    username: "admin",
    email: "admin@example.com",
    displayName: "Ada Admin",
    role: "admin",
  },
  state: "active",
  recentSignInUntil: null,
};

export const userSession: Session = {
  account: {
    id: "0b6f6c62-7a39-4e4b-9a55-1b2a1f4c3d02",
    username: "user",
    email: "user@example.com",
    displayName: "Una User",
    role: "user",
  },
  state: "active",
  recentSignInUntil: null,
};

/** The Dashboard's counts of a new instance: nothing yet. */
export const emptyDashboard: Dashboard = {
  users: { active: 0, disabled: 0 },
  pendingInvitations: 0,
  resources: { available: 0, unavailable: 0 },
  shareLinks: { active: 0, expired: 0, revoked: 0, locked: 0, downloads: 0 },
  recentUploaders: [],
};

export interface BaseApiOptions {
  /** @defaultValue true */
  readonly adminExists?: boolean;
  /** The signed-in session; signed out when null or left out. */
  readonly session?: Session | null;
}

/** The two requests every page makes: the setup status and the session. */
export function baseHandlers({ adminExists = true, session = null }: BaseApiOptions = {}): Record<string, MockHandler> {
  return {
    "GET /api/v1/setup/status": () => json(200, { adminExists }),
    "GET /api/v1/session": () => (session === null ? problem(401, problemTypes.signInRequired, "Sign in") : json(200, session)),
    "GET /api/v1/admin/audit-events": () => json(200, { events: [], nextCursor: null }),
    "GET /api/v1/admin/dashboard": () => json(200, emptyDashboard),
    "GET /api/v1/sso/providers": () => json(200, { providers: [] }),
    "GET /api/v1/home/entries": () => json(200, { path: "", entries: [], nextCursor: null }),
    "GET /api/v1/home/quota": () => json(200, { usedBytes: 0, limitBytes: 10_000_000_000 }),
  };
}

/**
 * Stubs `fetch` with handlers by `"METHOD /path"`; any other request answers 404. Returns the mock,
 * whose calls hold every request.
 */
export function stubApi(handlers: Record<string, MockHandler>) {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const handler = handlers[`${method} ${url.pathname}`];
    return handler === undefined ? problem(404, problemTypes.notFound, "Not found") : handler({ method, url, body });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The requests made to one route, by `"METHOD /path"`. */
export function requestsTo(fetchMock: ReturnType<typeof stubApi>, route: string): MockRequest[] {
  return fetchMock.mock.calls.flatMap(([input, init]) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    const method = init?.method ?? "GET";
    if (`${method} ${url.pathname}` !== route) return [];
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    return [{ method, url, body }];
  });
}
