import {
  problemTypes,
  type addResourceRoute,
  type allowFolderRoute,
  type changeResourceRoute,
  type checkResourceRoute,
  type getResourceRoute,
  type listResourcesRoute,
  type removeResourceRoute,
  type retryResourceRoute,
  type setHomeRootRoute,
} from "@not-unreachable/contracts";
import type { FastifyRequest } from "fastify";
import { HttpProblem, requireCaller, type RouteHandlers } from "../../http/index.ts";
import type { AuditActor } from "../audit/index.ts";
import type { AllowedFoldersService } from "./allowed-folders.ts";
import { NameRefusedError, PathRefusedError } from "../storage/index.ts";
import {
  FolderRefusedError,
  ResourceInUseError,
  ResourceKindMismatchError,
  ResourceNameTakenError,
  ResourceNotFoundError,
  ResourceUnavailableError,
  SharePasswordRequiredError,
  ShareRefusedError,
} from "./errors.ts";
import type { ResourcesService } from "./service.ts";

export type ResourcesRoutes = {
  readonly listResources: typeof listResourcesRoute;
  readonly addResource: typeof addResourceRoute;
  readonly getResource: typeof getResourceRoute;
  readonly changeResource: typeof changeResourceRoute;
  readonly removeResource: typeof removeResourceRoute;
  readonly retryResource: typeof retryResourceRoute;
  readonly checkResource: typeof checkResourceRoute;
  readonly setHomeRoot: typeof setHomeRootRoute;
};

/** Registered apart from the table's other routes, and only while `ALLOW_FOLDERS_FROM_UI` is on. */
export type AllowFolderRoutes = {
  readonly allowFolder: typeof allowFolderRoute;
};

function folderRefusedProblem(error: FolderRefusedError): HttpProblem {
  const detail =
    error.command === null
      ? `The folder can't be used (${error.reason}).`
      : `The service can't write to this folder. Run this on the server, then try again: ${error.command}`;
  return new HttpProblem(
    422,
    problemTypes.folderRefused,
    detail,
    {},
    { reason: error.reason, ...(error.command === null ? {} : { command: error.command, allowFromUi: error.allowFromUi }) },
  );
}

/** The service's typed errors as problems; anything else is rethrown (a 500). */
function toProblem(error: unknown): unknown {
  if (error instanceof ResourceNotFoundError) return new HttpProblem(404, problemTypes.notFound);
  if (error instanceof FolderRefusedError) return folderRefusedProblem(error);
  if (error instanceof ShareRefusedError) {
    return new HttpProblem(
      422,
      problemTypes.shareRefused,
      `The share couldn't be mounted (${error.reason}).`,
      {},
      { reason: error.reason },
    );
  }
  if (error instanceof SharePasswordRequiredError) {
    return new HttpProblem(400, problemTypes.badRequest, "Enter the password again: a saved password is never sent to another server.");
  }
  if (error instanceof ResourceNameTakenError) return new HttpProblem(409, problemTypes.resourceNameTaken);
  if (error instanceof ResourceKindMismatchError) return new HttpProblem(400, problemTypes.badRequest, "A resource's kind can't change.");
  if (error instanceof ResourceUnavailableError) return new HttpProblem(409, problemTypes.resourceUnavailable);
  if (error instanceof ResourceInUseError) {
    const detail =
      error.reason === "home-root"
        ? "This resource holds the home root. Pick another home root first."
        : "Users' homes live in this resource, so it can't be removed.";
    return new HttpProblem(409, problemTypes.homeRootResource, detail, {}, { reason: error.reason });
  }
  if (error instanceof PathRefusedError || error instanceof NameRefusedError) {
    return new HttpProblem(422, problemTypes.pathRefused, undefined, {}, { reason: error.reason });
  }
  return error;
}

async function mapped<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toProblem(error);
  }
}

function actorOf(request: FastifyRequest): AuditActor {
  const caller = requireCaller(request);
  return { kind: "account", accountId: caller.accountId, username: caller.username };
}

export function createResourcesHandlers(service: ResourcesService): RouteHandlers<ResourcesRoutes> {
  return {
    listResources: async () => service.list(),

    addResource: async (request, reply) => {
      const resource = await mapped(() => service.add(request.body, actorOf(request), request.requestContext));
      return reply.code(201).send(resource);
    },

    getResource: async (request) => mapped(() => service.get(request.params.id)),

    changeResource: async (request) =>
      mapped(() => service.change(request.params.id, request.body, actorOf(request), request.requestContext)),

    removeResource: async (request, reply) => {
      await mapped(() => service.remove(request.params.id, actorOf(request), request.requestContext));
      return reply.code(204).send();
    },

    retryResource: async (request) => mapped(() => service.retry(request.params.id)),

    checkResource: async (request) => mapped(() => service.check(request.body)),

    setHomeRoot: async (request) => mapped(() => service.setHomeRoot(request.body, actorOf(request), request.requestContext)),
  };
}

export function createAllowFolderHandlers(service: AllowedFoldersService): RouteHandlers<AllowFolderRoutes> {
  return {
    allowFolder: async (request, reply) => {
      const { localPath, reauthentication } = request.body;
      await service.allow(requireCaller(request), localPath, reauthentication, request.requestContext);
      // Before the restart, which the helper schedules 3 seconds out.
      return reply.code(202).send();
    },
  };
}
