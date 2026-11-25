import { problemMediaType, problemSchema, routes, type Problem, type RouteContract, type RouteTable } from "@not-unreachable/contracts";
import type { z } from "zod";

type RequestPart = "params" | "query" | "body";

/** A route's params, query or body: required when its contract has the schema, absent otherwise. */
type PartOf<Route, Part extends RequestPart> =
  Route extends Readonly<Record<Part, infer Schema extends z.ZodType>>
    ? { readonly [P in Part]: z.input<Schema> }
    : { readonly [P in Part]?: never };

export type RequestOptions<Route extends RouteContract> = PartOf<Route, "params"> &
  PartOf<Route, "query"> &
  PartOf<Route, "body"> & { readonly signal?: AbortSignal };

/** The options argument may be left out when a route needs no params, query or body. */
export type RequestArgs<Route extends RouteContract> =
  Partial<RequestOptions<Route>> extends RequestOptions<Route> ? [options?: RequestOptions<Route>] : [options: RequestOptions<Route>];

/** The parsed success body: the union of the route's response schemas over its statuses. */
export type ResponseBody<Route extends RouteContract> = {
  [Status in keyof Route["responses"]]: Route["responses"][Status] extends z.ZodType ? z.output<Route["responses"][Status]> : never;
}[keyof Route["responses"]];

/**
 * The header every request but GET, HEAD and OPTIONS must carry with the value "1": the server's
 * CSRF check (threat model, T3). Uploads over tus send it too.
 */
export const REQUEST_MARKER_HEADER = "X-NU-Request";

/** An `application/problem+json` answer (or any other error status), as a typed error. */
export class ApiError extends Error {
  readonly problem: Problem;
  readonly status: number;
  /** The answer's `Retry-After`, in seconds, as a 429 or 503 sends it; undefined without one. */
  readonly retryAfterSeconds: number | undefined;

  constructor(problem: Problem, retryAfterSeconds?: number) {
    super(problem.detail ?? problem.title);
    this.name = "ApiError";
    this.problem = problem;
    this.status = problem.status;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  get type(): string {
    return this.problem.type;
  }
}

interface UntypedOptions {
  readonly params?: unknown;
  readonly query?: unknown;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalar(value: unknown, what: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  throw new TypeError(`${what} must be a string, number or boolean.`);
}

export function buildPath(path: string, params: unknown): string {
  const values = isRecord(params) ? params : {};
  return path.replaceAll(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined || value === null) throw new TypeError(`Missing path parameter "${name}".`);
    return encodeURIComponent(scalar(value, `Path parameter "${name}"`));
  });
}

export function buildQuery(query: unknown): string {
  if (query === undefined) return "";
  if (!isRecord(query)) throw new TypeError("The query must be an object.");
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? (value as readonly unknown[]) : [value]) {
      search.append(key, scalar(item, `Query parameter "${key}"`));
    }
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

/** A `Retry-After` in seconds; the HTTP-date form isn't sent by this server. */
function retryAfterOf(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null || !/^\d+$/.test(header.trim())) return undefined;
  return Number(header.trim());
}

async function toApiError(response: Response): Promise<ApiError> {
  const contentType = response.headers.get("content-type") ?? "";
  const retryAfter = retryAfterOf(response);
  if (contentType.split(";")[0]?.trim().toLowerCase() === problemMediaType) {
    const parsed = problemSchema.safeParse(await readJson(response).catch(() => undefined));
    if (parsed.success) return new ApiError(parsed.data, retryAfter);
  }
  return new ApiError({ type: "about:blank", title: response.statusText || "Request failed", status: response.status }, retryAfter);
}

/** A typed client over a route table: call a route by name, get its parsed response or an ApiError. */
export function createApiClient<Table extends RouteTable>(table: Table) {
  return async function call<Name extends keyof Table & string>(
    name: Name,
    ...[options]: RequestArgs<Table[Name]>
  ): Promise<ResponseBody<Table[Name]>> {
    const route: RouteContract | undefined = table[name];
    if (route === undefined) throw new TypeError(`Unknown route "${name}".`);
    const request: UntypedOptions = options ?? {};
    const headers = new Headers({ Accept: "application/json", [REQUEST_MARKER_HEADER]: "1" });
    const init: RequestInit = { method: route.method, headers, credentials: "same-origin" };
    if (request.body !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(request.body);
    }
    if (request.signal !== undefined) init.signal = request.signal;

    const response = await fetch(buildPath(route.path, request.params) + buildQuery(request.query), init);
    if (!response.ok) throw await toApiError(response);

    const schema = route.responses[response.status];
    if (schema === undefined) throw new Error(`Unexpected status ${response.status} from ${name}.`);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- schema is this route's response schema for this status.
    return schema.parse(await readJson(response)) as ResponseBody<Table[Name]>;
  };
}

/** The client for this app's API (packages/contracts). */
export const api = createApiClient(routes);
