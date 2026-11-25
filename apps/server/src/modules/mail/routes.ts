import { problemTypes, type getMailSettingsRoute, type sendTestEmailRoute, type updateMailSettingsRoute } from "@not-unreachable/contracts";
import { HttpProblem, requireCaller, type RouteHandlers } from "../../http/index.ts";
import { actorOf } from "../audit/index.ts";
import { MailNotConfiguredError, MailSendFailedError, type MailService } from "./service.ts";

export type MailRoutes = {
  readonly getMailSettings: typeof getMailSettingsRoute;
  readonly updateMailSettings: typeof updateMailSettingsRoute;
  readonly sendTestEmail: typeof sendTestEmailRoute;
};

/** The admin's own address, which the test email goes to; null when the account has none. */
export type FindAccountEmail = (accountId: string) => string | null;

function asProblem(error: unknown): unknown {
  if (error instanceof MailNotConfiguredError) {
    return new HttpProblem(409, problemTypes.smtpNotConfigured, "Set up the email server first.");
  }
  if (error instanceof MailSendFailedError) {
    return new HttpProblem(502, problemTypes.mailSendFailed, "The email server could not be reached or refused the message.");
  }
  return error;
}

export function createMailHandlers(service: MailService, findAccountEmail: FindAccountEmail): RouteHandlers<MailRoutes> {
  return {
    getMailSettings: async () => service.getSettings(),

    updateMailSettings: async (request) => {
      const caller = requireCaller(request);
      return service.updateSettings(request.body, { actor: actorOf(caller), origin: request.requestContext });
    },

    sendTestEmail: async (request) => {
      const caller = requireCaller(request);
      const to = findAccountEmail(caller.accountId);
      if (to === null) throw new HttpProblem(422, problemTypes.validationFailed, "Your account has no email address.");
      try {
        return await service.sendTest(to, { actor: actorOf(caller), origin: request.requestContext });
      } catch (error) {
        throw asProblem(error);
      }
    },
  };
}
