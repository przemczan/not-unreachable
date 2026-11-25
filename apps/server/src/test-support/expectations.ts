import { problemMediaType, problemSchema, type Problem } from "@not-unreachable/contracts";
import type { LightMyRequestResponse } from "fastify";
import { expect } from "vitest";

/** Asserts an RFC 9457 answer with this status and type, and that its body names no stack or path. */
export function expectProblem(response: LightMyRequestResponse, status: number, type: string): Problem {
  expect(response.statusCode).toBe(status);
  expect(response.headers["content-type"]).toBe(`${problemMediaType}; charset=utf-8`);
  const body = problemSchema.parse(response.json());
  expect(body).toMatchObject({ status, type });
  expect(response.body).not.toMatch(/\s+at\s|\/var\/|\/tmp\/|\/home\/|node_modules|\.ts:|\.js:/);
  return body;
}

export function corsHeaders(response: LightMyRequestResponse): string[] {
  return Object.keys(response.headers).filter((name) => name.startsWith("access-control-"));
}
