import {
  problemTypes,
  UPLOAD_PATCH_MAX_BYTES,
  type cancelUploadRoute,
  type createHomeFolderRoute,
  type createResourceFolderRoute,
  type createUploadRoute,
  type deleteHomeEntryRoute,
  type deleteResourceEntryRoute,
  type downloadHomeFileRoute,
  type downloadResourceFileRoute,
  type getHomeQuotaRoute,
  type getUploadLimitsRoute,
  type getUploadOffsetRoute,
  type listHomeEntriesRoute,
  type listResourceEntriesRoute,
  type sendUploadChunkRoute,
  type updateUploadLimitsRoute,
} from "@not-unreachable/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { HttpProblem, requireCaller, type Caller, type RouteHandlers } from "../../http/index.ts";
import { actorOf } from "../audit/index.ts";
import { sendContained } from "./download.ts";
import { mapped } from "./problems.ts";
import type { FilesPlace, FilesService } from "./service.ts";
import { limitedBody, replyHeaders, tusRequest, UPLOADS_PATH, withTusHeader, type UploadCall, type UploadsGateway } from "./uploads.ts";

export type FilesRoutes = {
  readonly listResourceEntries: typeof listResourceEntriesRoute;
  readonly createResourceFolder: typeof createResourceFolderRoute;
  readonly downloadResourceFile: typeof downloadResourceFileRoute;
  readonly deleteResourceEntry: typeof deleteResourceEntryRoute;
  readonly listHomeEntries: typeof listHomeEntriesRoute;
  readonly createHomeFolder: typeof createHomeFolderRoute;
  readonly downloadHomeFile: typeof downloadHomeFileRoute;
  readonly deleteHomeEntry: typeof deleteHomeEntryRoute;
  readonly getHomeQuota: typeof getHomeQuotaRoute;
  readonly createUpload: typeof createUploadRoute;
  readonly getUploadOffset: typeof getUploadOffsetRoute;
  readonly sendUploadChunk: typeof sendUploadChunkRoute;
  readonly cancelUpload: typeof cancelUploadRoute;
  readonly getUploadLimits: typeof getUploadLimitsRoute;
  readonly updateUploadLimits: typeof updateUploadLimitsRoute;
};

/** A user's root is their own home, found from the session; never anything the request names (T5 step 8). */
function homeOf(request: FastifyRequest): FilesPlace {
  return { kind: "home", username: requireCaller(request).username };
}

function resourceOf(resourceId: string): FilesPlace {
  return { kind: "resource", resourceId };
}

function uploadCall(request: FastifyRequest): UploadCall {
  const caller: Caller = requireCaller(request);
  return {
    caller: { accountId: caller.accountId, username: caller.username, role: caller.role },
    origin: request.requestContext,
  };
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function chunkTooLarge(): HttpProblem {
  return withTusHeader(
    new HttpProblem(413, problemTypes.payloadTooLarge, `A chunk may hold no more than ${UPLOAD_PATCH_MAX_BYTES} bytes.`),
  );
}

export function createFilesHandlers(service: FilesService, uploads: UploadsGateway): RouteHandlers<FilesRoutes> {
  /** Hands the request to tus and answers what it answered, without any CORS header. */
  const forward = async (
    request: FastifyRequest,
    reply: FastifyReply,
    path: string,
    call: UploadCall,
    body?: ReadableStream<Uint8Array>,
  ): Promise<Response> => {
    const answer = await uploads.handle(tusRequest(request.method, path, request.headers, body), call);
    reply.code(answer.status).headers(replyHeaders(answer));
    return answer;
  };

  /** HEAD, PATCH and DELETE reach only the caller's own upload; any other is a 404, as if there were none. */
  const ownUpload = (request: FastifyRequest, uploadId: string): UploadCall => {
    const call = uploadCall(request);
    try {
      service.assertOwnUpload(call.caller.accountId, uploadId);
    } catch {
      throw withTusHeader(new HttpProblem(404, problemTypes.notFound));
    }
    return call;
  };

  return {
    listResourceEntries: async (request) => mapped(() => service.list(resourceOf(request.params.resourceId), request.query)),

    createResourceFolder: async (request, reply) => {
      const entry = await mapped(() => service.createFolder(resourceOf(request.params.resourceId), request.body.path, request.body.name));
      return reply.code(201).send(entry);
    },

    downloadResourceFile: async (request, reply) => {
      const path = await mapped(() => service.resolve(resourceOf(request.params.resourceId), request.query.path));
      return mapped(() => sendContained(request, reply, path));
    },

    deleteResourceEntry: async (request, reply) => {
      const caller = requireCaller(request);
      await mapped(() => service.delete(resourceOf(request.params.resourceId), request.query, actorOf(caller), request.requestContext));
      return reply.code(204).send();
    },

    listHomeEntries: async (request) => mapped(() => service.list(homeOf(request), request.query)),

    createHomeFolder: async (request, reply) => {
      const entry = await mapped(() => service.createFolder(homeOf(request), request.body.path, request.body.name));
      return reply.code(201).send(entry);
    },

    downloadHomeFile: async (request, reply) => {
      const path = await mapped(() => service.resolve(homeOf(request), request.query.path));
      return mapped(() => sendContained(request, reply, path));
    },

    deleteHomeEntry: async (request, reply) => {
      const caller = requireCaller(request);
      await mapped(() => service.delete(homeOf(request), request.query, actorOf(caller), request.requestContext));
      return reply.code(204).send();
    },

    getHomeQuota: async (request) => {
      const caller = requireCaller(request);
      return mapped(() => service.quota(caller.accountId, caller.username));
    },

    createUpload: async (request, reply) => {
      const call = uploadCall(request);
      // No deferred length (threat model, T7): refused before tus runs.
      if (request.headers["upload-defer-length"] !== undefined || single(request.headers["upload-length"]) === undefined) {
        throw withTusHeader(new HttpProblem(400, problemTypes.uploadLengthRequired, "Send the file's size as Upload-Length."));
      }
      await forward(request, reply, UPLOADS_PATH, call);
      return reply.send();
    },

    getUploadOffset: async (request, reply) => {
      const call = ownUpload(request, request.params.id);
      await forward(request, reply, `${UPLOADS_PATH}/${request.params.id}`, call);
      return reply.send();
    },

    sendUploadChunk: async (request, reply) => {
      const { id } = request.params;
      const call = ownUpload(request, id);
      const declared = Number(single(request.headers["content-length"]) ?? "0");
      if (declared > UPLOAD_PATCH_MAX_BYTES) throw chunkTooLarge();
      const body = limitedBody(request.raw, UPLOAD_PATCH_MAX_BYTES, () => {
        call.problem = chunkTooLarge();
        // The rest of the body is never read, so the connection can't be used again.
        reply.header("connection", "close");
      });
      const answer = await forward(request, reply, `${UPLOADS_PATH}/${id}`, call, body);
      const offset = Number(answer.headers.get("upload-offset"));
      // The last chunk forgot the upload already; any other moves its expiry on.
      if (Number.isSafeInteger(offset)) service.recordChunk(id, offset);
      return reply.send();
    },

    cancelUpload: async (request, reply) => {
      const call = ownUpload(request, request.params.id);
      await forward(request, reply, `${UPLOADS_PATH}/${request.params.id}`, call);
      return reply.send();
    },

    getUploadLimits: async () => service.limits(),

    updateUploadLimits: async (request) => {
      const caller = requireCaller(request);
      return service.updateLimits(
        request.body,
        { kind: "account", accountId: caller.accountId, username: caller.username },
        request.requestContext,
      );
    },
  };
}
