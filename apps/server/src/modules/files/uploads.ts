import { createUploadRoute, problemTypes, TUS_VERSION, type ProblemType } from "@not-unreachable/contracts";
import { Server } from "@tus/server";
import { Upload, type KvStore } from "@tus/utils";
import { HttpProblem } from "../../http/index.ts";
import type { AuditOrigin } from "../audit/index.ts";
import { newId, type Clock, type Logger } from "../platform/index.ts";
import { refusalProblem } from "./problems.ts";
import type { UploadsRepository } from "./repository.ts";
import { uploadMetadataOf, type FilesService, type UploadCaller } from "./service.ts";
import type { StagingArea } from "./staging.ts";

/*
 * tus 1.0.0 (stack.md, "Resumable uploads: tus") through `@tus/server`, called from our own contract
 * routes with a web `Request`: the guard, the CSRF checks and the ownership check have run before.
 * Every check of ours runs in tus's hooks; a refusal there is kept per request and answered as
 * problem+json by the route.
 */

/** Where tus thinks it is mounted: `Location` is `/api/v1/uploads/<id>`. */
export const UPLOADS_PATH = createUploadRoute.path;

/** The request headers tus reads; nothing else reaches it. */
const TUS_REQUEST_HEADERS = [
  "tus-resumable",
  "upload-length",
  "upload-defer-length",
  "upload-offset",
  "upload-metadata",
  "upload-concat",
  "content-type",
  "content-length",
] as const;

/** What one tus request carries for the hooks, and the refusal they leave for the route. */
export interface UploadCall {
  readonly caller: UploadCaller;
  readonly origin: AuditOrigin;
  problem?: HttpProblem;
}

/** What tus answers for an error thrown in a hook: its status, and its body (a short text). */
class TusRefusal extends Error {
  override readonly name = "TusRefusal";
  readonly status_code: number;
  readonly body: string;

  constructor(problem: HttpProblem) {
    super(problem.message);
    this.status_code = problem.status;
    this.body = `${problem.message}\n`;
  }
}

/** The problem types tus's own errors stand for. */
const tusProblemTypes: Partial<Record<number, ProblemType>> = {
  400: problemTypes.badRequest,
  403: problemTypes.forbidden,
  404: problemTypes.notFound,
  410: problemTypes.notFound,
  413: problemTypes.payloadTooLarge,
  415: problemTypes.unsupportedMediaType,
};

/** Every answer about an upload names the protocol version, errors included. */
export function withTusHeader(problem: HttpProblem): HttpProblem {
  return new HttpProblem(
    problem.status,
    problem.type,
    problem.detail,
    { ...problem.headers, "tus-resumable": TUS_VERSION },
    problem.extensions,
  );
}

/** A tus error answer (no hook of ours refused) as a problem; a 410 is a 404 like any missing upload. */
async function tusProblem(answer: Response): Promise<HttpProblem> {
  if (answer.status >= 500) return withTusHeader(new HttpProblem(500, problemTypes.internalError));
  const status = answer.status === 410 ? 404 : answer.status;
  const detail = (await answer.text()).trim().slice(0, 200);
  return withTusHeader(new HttpProblem(status, tusProblemTypes[status] ?? problemTypes.badRequest, detail === "" ? undefined : detail));
}

/** tus's store of upload records, over the `uploads` table: our creation checks make each row. */
export function uploadsConfigstore(repository: UploadsRepository): KvStore {
  return {
    get: async (id) => {
      const row = repository.find(id);
      if (row === undefined) return undefined;
      return new Upload({ id, size: row.size, offset: row.offset, metadata: uploadMetadataOf(row), creation_date: row.createdAt });
    },
    // The row was inserted by the creation checks, before tus stores anything.
    set: async () => undefined,
    delete: async (id) => {
      repository.delete(id);
    },
    list: async () => repository.listIds(),
  };
}

export interface UploadsGateway {
  /** Hands the request to tus; answers tus's answer, or throws the problem a hook or tus refused it with. */
  handle(request: Request, call: UploadCall): Promise<Response>;
}

export interface UploadsGatewayDependencies {
  readonly service: FilesService;
  readonly staging: StagingArea;
  readonly clock: Clock;
  readonly logger: Logger;
}

export function createUploadsGateway({ service, staging, clock, logger }: UploadsGatewayDependencies): UploadsGateway {
  const calls = new WeakMap<Request, UploadCall>();
  let server: Server | undefined;

  const callOf = (request: Request): UploadCall => {
    const call = calls.get(request);
    if (call === undefined) throw new Error("A tus request without its call");
    return call;
  };

  /** Keeps the refusal for the route and tells tus to stop with its status. */
  const refuse = (request: Request, error: unknown): never => {
    const problem = refusalProblem(error);
    if (problem === undefined) throw error;
    callOf(request).problem = problem;
    throw new TusRefusal(problem);
  };

  const serverOf = (): Server => {
    server ??= new Server({
      path: UPLOADS_PATH,
      datastore: staging.store(),
      relativeLocation: true,
      respectForwardedHeaders: false,
      // Same origin only: tus must never send a CORS header (T3); the route strips any it adds.
      allowedOrigins: () => false,
      namingFunction: () => newId(clock),
      onUploadCreate: async (request, upload) => {
        const { caller } = callOf(request);
        try {
          await service.createUpload(caller, upload.id, upload.metadata, upload.size ?? 0);
        } catch (error) {
          refuse(request, error);
        }
        return {};
      },
      onUploadFinish: async (request, upload) => {
        const { caller, origin } = callOf(request);
        try {
          await service.finishUpload(caller, upload.id, origin);
        } catch (error) {
          refuse(request, error);
        }
        return {};
      },
      onResponseError: (_request, error) => {
        if (!(error instanceof TusRefusal) && error instanceof Error) logger.error({ err: error }, "Upload request failed");
        return undefined;
      },
    });
    return server;
  };

  return {
    async handle(request, call) {
      calls.set(request, call);
      const answer = await serverOf().handleWeb(request);
      if (call.problem !== undefined) throw withTusHeader(call.problem);
      if (answer.status >= 400) throw await tusProblem(answer);
      return answer;
    },
  };
}

/** The tus request for a route's request: its path, its method, only the tus headers, and the body if any. */
export function tusRequest(
  method: string,
  path: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  body?: ReadableStream<Uint8Array>,
): Request {
  const forwarded = new Headers();
  for (const name of TUS_REQUEST_HEADERS) {
    const value = headers[name];
    if (typeof value === "string") forwarded.set(name, value);
  }
  return new Request(new URL(path, "http://uploads.invalid"), {
    method,
    headers: forwarded,
    ...(body === undefined ? {} : { body, duplex: "half" }),
  });
}

/**
 * The request body as a web stream that errors past `maxBytes`, calling `onTooLarge` first: the app's
 * 1 MiB body limit doesn't apply to a raw body, so this is its limit. The source is never destroyed
 * (that would reset the connection before the answer); the route closes the connection instead.
 */
export function limitedBody(source: AsyncIterable<unknown>, maxBytes: number, onTooLarge: () => void): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done === true) {
        controller.close();
        return;
      }
      const bytes: unknown = next.value;
      const chunk = bytes instanceof Uint8Array ? bytes : Buffer.from(String(bytes));
      total += chunk.byteLength;
      if (total > maxBytes) {
        onTooLarge();
        controller.error(new Error("The chunk is larger than the limit"));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

/** tus's answer headers for the route's reply: never a CORS header, nor the framing ones Fastify sets. */
export function replyHeaders(answer: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of answer.headers) {
    if (name.startsWith("access-control-") || name === "content-length" || name === "connection") continue;
    headers[name] = value;
  }
  return headers;
}
