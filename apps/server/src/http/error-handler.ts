import { problemTypes, type Problem, type ProblemType } from "@not-unreachable/contracts";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { HttpProblem, problem, sendProblem } from "./problems.ts";

const MAX_VALIDATION_ISSUES = 10;

const problemTypeByStatus: Partial<Record<number, ProblemType>> = {
  400: problemTypes.badRequest,
  403: problemTypes.forbidden,
  404: problemTypes.notFound,
  405: problemTypes.methodNotAllowed,
  413: problemTypes.payloadTooLarge,
  415: problemTypes.unsupportedMediaType,
  416: problemTypes.rangeNotSatisfiable,
  429: problemTypes.rateLimited,
};

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const status = error.statusCode;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function validationDetail(error: unknown): string | undefined {
  if (!hasZodFastifySchemaValidationErrors(error)) return undefined;
  const context = "validationContext" in error && typeof error.validationContext === "string" ? error.validationContext : "request";
  return error.validation
    .slice(0, MAX_VALIDATION_ISSUES)
    .map((issue) => `${context}${issue.instancePath === "/" ? "" : issue.instancePath}: ${issue.message}`)
    .join("; ");
}

/**
 * Maps any error to a problem. Client errors keep their status with a stable type; everything
 * else is a 500 whose body names nothing (no message, stack or path) — the log has the error.
 */
export function problemFor(error: unknown): Problem {
  if (error instanceof HttpProblem) return error.toProblem();
  if (typeof error === "object" && error !== null && "validation" in error) {
    return problem(400, problemTypes.validationFailed, validationDetail(error));
  }
  const status = statusOf(error);
  if (status !== undefined && status >= 400 && status < 500) {
    return problem(status, problemTypeByStatus[status] ?? problemTypes.badRequest);
  }
  return problem(500, problemTypes.internalError);
}

function handleError(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const body = problemFor(error);
  if (error instanceof HttpProblem) reply.headers(error.headers);
  if (body.status >= 500) request.log.error({ err: error }, "Request failed");
  else request.log.info({ status: body.status, type: body.type, code: codeOf(error) }, "Request rejected");
  return sendProblem(reply, body);
}

/** One error handler for the whole app: every error answer is RFC 9457 problem+json. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(handleError);
}

/** For errors Fastify raises before any hook runs (a malformed URL): the same problem body, plus the security headers. */
export function frameworkErrorHandler(headers: Record<string, string>) {
  return (error: FastifyError, request: FastifyRequest, reply: FastifyReply): void => {
    reply.headers({ ...headers, "cache-control": "no-store" });
    void handleError(error, request, reply);
  };
}
