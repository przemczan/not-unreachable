import type {
  acknowledgeRecoveryCodesRoute,
  confirmPasskeyEnrolmentRoute,
  confirmTotpEnrolmentRoute,
  getSecondFactorStepRoute,
  passPasskeyRoute,
  passRecoveryCodeRoute,
  passTotpRoute,
  startPasskeyEnrolmentRoute,
  startPasskeySecondFactorRoute,
  startTotpEnrolmentRoute,
} from "@not-unreachable/contracts";
import type { FastifyReply } from "fastify";
import { requireCaller, type RouteHandlers } from "../../http/index.ts";
import type { Clock } from "../platform/index.ts";
import { sessionCookie } from "../sessions/index.ts";
import { sessionView } from "./routes.ts";
import type { PassedStep, SecondFactorStepService } from "./second-factor-step.ts";

/** The sign-in step after the password, for a session pending its second factor. */
export type SecondFactorStepRoutes = {
  readonly getSecondFactorStep: typeof getSecondFactorStepRoute;
  readonly passTotp: typeof passTotpRoute;
  readonly passRecoveryCode: typeof passRecoveryCodeRoute;
  readonly startPasskeySecondFactor: typeof startPasskeySecondFactorRoute;
  readonly passPasskey: typeof passPasskeyRoute;
  readonly startTotpEnrolment: typeof startTotpEnrolmentRoute;
  readonly confirmTotpEnrolment: typeof confirmTotpEnrolmentRoute;
  readonly startPasskeyEnrolment: typeof startPasskeyEnrolmentRoute;
  readonly confirmPasskeyEnrolment: typeof confirmPasskeyEnrolmentRoute;
  readonly acknowledgeRecoveryCodes: typeof acknowledgeRecoveryCodesRoute;
};

export function createSecondFactorStepHandlers(step: SecondFactorStepService, clock: Clock): RouteHandlers<SecondFactorStepRoutes> {
  /** The session is active now, with a new token and a recent sign-in. */
  const activeSession = (reply: FastifyReply, { account, token }: PassedStep) => {
    reply.header("set-cookie", sessionCookie(token));
    return sessionView(account, "active", clock.now());
  };

  return {
    getSecondFactorStep: async (request) => step.step(requireCaller(request)),

    passTotp: async (request, reply) =>
      activeSession(reply, await step.passTotp(requireCaller(request), request.body.code, request.requestContext)),

    passRecoveryCode: async (request, reply) =>
      activeSession(reply, await step.passRecoveryCode(requireCaller(request), request.body.code, request.requestContext)),

    startPasskeySecondFactor: async (request) => step.passkeyOptions(requireCaller(request)),

    passPasskey: async (request, reply) =>
      activeSession(reply, await step.passPasskey(requireCaller(request), request.body.response, request.requestContext)),

    startTotpEnrolment: async (request) => step.startEnrolment(requireCaller(request)),

    confirmTotpEnrolment: async (request) =>
      step.confirmEnrolment(requireCaller(request), request.body.id, request.body.code, request.requestContext),

    startPasskeyEnrolment: async (request) => step.startPasskeyEnrolment(requireCaller(request)),

    confirmPasskeyEnrolment: async (request) => step.confirmPasskeyEnrolment(requireCaller(request), request.body, request.requestContext),

    acknowledgeRecoveryCodes: async (request, reply) =>
      activeSession(reply, step.acknowledgeRecoveryCodes(requireCaller(request), request.requestContext)),
  };
}
